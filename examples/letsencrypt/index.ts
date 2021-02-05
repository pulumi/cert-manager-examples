import * as aws from "@pulumi/aws";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as certmgr from "../../cert-manager";
import * as rbac from "./rbac";

const projectName = pulumi.getProject();
const config = new pulumi.Config();
const acmeEmail = config.require("acmeEmail");
const acmeServerUrl = config.get("acmeServerUrl") || "https://acme-staging-v02.api.letsencrypt.org/directory";
const issuerKeySecretName = config.get("issuerPrivateKeySecretName") || "letsencrypt-issuer-private-key";
const r53HostedZone = config.require("r53HostedZoneName");
const appDomain = config.get("r53AppDomain") || "kuard-le";
const certDnsNames = [`${appDomain}.${r53HostedZone}`, `${appDomain}-svc.${r53HostedZone}`];

const env = pulumi.getStack();
const infra = new pulumi.StackReference(`jaxxstorm/cert-manager-infra/${env}`);
const provider = new k8s.Provider("k8s", { kubeconfig: infra.getOutput("kubeconfig") });
const oidcProviderUrl = infra.getOutput("oidcProviderUrl");
const oidcProviderArn = infra.getOutput("oidcProviderArn");


// =============================================================================
// Deploy the cert-manager.
// =============================================================================

export const namespaceName = "cert-manager";
const namespace = new k8s.core.v1.Namespace("cert-manager", {
    metadata: {name: namespaceName},
}, {provider: provider});

// Create a ServiceAccount in the namespace with AWS IAM permissions to configure DNS in Route53.
const saIamRole = rbac.CreateServiceAccountIAMRole("cert-manager",
    namespaceName,
    oidcProviderArn,
    oidcProviderUrl,
);

// Create and deploy the cert-manager.
const certManager = new certmgr.CertManager("cert-manager", {
    namespaceName,
    iamRoleArn: saIamRole.arn,
    helmChartVersion: "v1.0.3",
    provider: provider,
});
const certMgrReady = certManager.chart.resources.apply((m: Record<string, unknown>) => pulumi.all(m).apply(m => Object.values(m).map(r => pulumi.output(r))));

const webhookSvc = certMgrReady.apply(c => {
    return certManager.chart.getResource("v1/Service", "cert-manager/cert-manager-webhook")
});

// =============================================================================
// Deploy the Nginx Ingress Controller.
// =============================================================================

const nginxName = "nginx";
const nginxSvcNsName = `${namespaceName}/${nginxName}`;
const nginx = new k8s.helm.v3.Chart(nginxName,
    {
        namespace: namespaceName,
        chart: "ingress-nginx",
        version: "3.4.1",
        fetchOpts: {repo: "https://kubernetes.github.io/ingress-nginx"},
        values: {
            controller: {
                publishService: {enabled: true, pathOverride: nginxSvcNsName},
                service: {enabled: false},
                admissionWebhooks: {enabled: false},
            },
        },
    },
    {provider: provider},
);

// Create a LoadBalancer Service for the NGINX Deployment
const labels = {"app.kubernetes.io/instance": "nginx", "app.kubernetes.io/component": "controller", "app.kubernetes.io/name": "ingress-nginx"}
const nginxSvc = new k8s.core.v1.Service(nginxName,
    {
        metadata: {labels, namespace: namespaceName, name: nginxName},
        spec: {
            type: "LoadBalancer",
            ports: [{name:"http", port: 80, targetPort: "http"},{name:"https", port: 443, targetPort: "https"}],
            selector: labels,
        },
    },{provider: provider}
);
const lbEndpoint = nginxSvc.status.loadBalancer.ingress.apply(ingress => ingress[0].hostname);

// =============================================================================
// Create a cert-manager Issuer and Certificate for the Demo App to use.
// =============================================================================

// Deploy cert-manager using the DNS provider in the ACME challenge
// for the R53 hosted zones.
const regionName = pulumi.output(aws.getRegion({}, {async: true})).name;
const certMgrName = "cert-manager";
const secretName = config.get("tlsCertificateName") || "letsencrypt-cert"

// Create a Issuer for cert-manager in the namespace.
const issuer = new certmgr.crds.certmanager.v1.ClusterIssuer(certMgrName, {
    metadata: {name: certMgrName, annotations: {"webhook": webhookSvc.id}},
    spec: {
        acme: {
            server: acmeServerUrl,
            email: acmeEmail,
            privateKeySecretRef: {
                name: issuerKeySecretName,
            },
            solvers: [{
                selector: {
                    dnsZones: certDnsNames,
                },
                dns01: {
                    route53: {
                        region: regionName,
                    },
                },
            }],
        }
    },
}, {provider: provider});

const certificate = new certmgr.crds.certmanager.v1.Certificate(certMgrName, {
    metadata: {namespace: namespaceName},
    spec: {
        secretName,
        dnsNames: certDnsNames,
        issuerRef: {name: certMgrName, kind: issuer.kind},
    },
}, {provider: provider});

// const invalidCert = new certmgr.crds.certmanager.v1.Certificate("invalid-cert", {
//     metadata: {namespace: namespaceName},
//     spec: {
//         secretName,
//         dnsNames: [ "kuard.example.net" ],
//         issuerRef: {name: certMgrName, kind: issuer.kind},
//     }
// })

// =============================================================================
// Deploy the Demo App Service, Ingress, and R53 DNS Record
// =============================================================================

const appName = "kuard"
const r53Zone = aws.route53.getZone({
    name: r53HostedZone,
});

const kuardDnsRecord = new aws.route53.Record(appName, {
    zoneId: r53Zone.then(r => r.zoneId),
    name: r53Zone.then(r53Zone => `${appDomain}.${r53Zone.name}`),
    type: "CNAME",
    ttl: 300,
    records: [lbEndpoint],
});

// Create a kuard Deployment
const appLabels = {app: appName}
const deployment = new k8s.apps.v1.Deployment(appName,
    {
        metadata: { namespace: namespaceName, labels: appLabels},
        spec: {
            replicas: 1,
            selector: { matchLabels: appLabels },
            template: {
                metadata: {labels:appLabels},
                spec: {
                    containers: [
                        {
                            name: appName,
                            image: "gcr.io/kuar-demo/kuard-amd64:blue",
                            resources: {requests: {cpu: "50m", memory: "20Mi"}},
                            ports: [{ name: "http", containerPort: 8080 }]
                        }
                    ],
                }
            }
        },
    },
    {provider: provider},
);

// Create a Service for the kuard Deployment
const service = new k8s.core.v1.Service(appName,
    {
        metadata: {labels:appLabels, namespace: namespaceName},
        spec: {ports: [{ port: 8080, targetPort: "http" }], selector: appLabels},
    },
    {provider: provider}
);

// Create the kuard Ingress
const ingress = new k8s.networking.v1beta1.Ingress(appName,
    {
        metadata: { labels:appLabels, namespace: namespaceName,
            annotations: {"kubernetes.io/ingress.class": "nginx"},
        },
        spec: {
            tls: [
                {
                    hosts: [`${appDomain}.${r53HostedZone}`],
                    secretName,
                },
            ],
            rules: [
                {
                    host: `${appDomain}.${r53HostedZone}`,
                    http: {
                        paths: [{path: "/", backend: { serviceName: service.metadata.name, servicePort: "http"}}],
                    },
                },
            ],
        }
    },
    {provider: provider},
);

export const address = certDnsNames
