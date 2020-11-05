import * as aws from "@pulumi/aws";
import * as venafi from "@pulumi/venafi";
import * as eks from "@pulumi/eks";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as certmgr from "../../cert-manager";
import * as dns from "dns";
import * as util from "util";

const projectName = pulumi.getProject();
const config = new pulumi.Config();
const r53HostedZone = config.require("r53HostedZoneName");
const appDomain = config.get("r53AppDomain") || "kuard-venafi-tpp";
const certDnsNames = [`${appDomain}.${r53HostedZone}`, `${appDomain}-svc.${r53HostedZone}`]; // Venafi TPP requires 1+ cert-dns names, plus setting the commonName
const venafiTppZone = config.require("venafiTppZone");
const venafiTppEndpoint = config.require("venafiTppEndpoint");
const venafiTppUrl = config.require("venafiTppUrl");

// =============================================================================
// Create an EKS cluster with an OIDC provider.
// =============================================================================

const cluster = new eks.Cluster(`${projectName}`, {
    createOidcProvider: true,
});

// Export the cluster's kubeconfig.
export const kubeconfig = cluster.kubeconfig;

// Check for the cluster OIDC provider to use per-Pod IAM.
if (!cluster?.core?.oidcProvider) {
    throw new Error("Invalid cluster OIDC provider URL");
}

// =============================================================================
// Deploy the cert-manager.
// =============================================================================

export const namespaceName = "cert-manager";
const namespace = new k8s.core.v1.Namespace("cert-manager", {
    metadata: {name: namespaceName},
}, {provider: cluster.provider});

// The Venafi TPP endpoint certificate is not associated with the endpoint URL
// itself, but instead the SAN used e.g. tpp.venafidemo.com. We must resolve
// it's address, and add it as a host alias in the cert-manager Pod to properly request certs.
// e.g. Otherwise it errors with:
// Venafi client: Post "https://<subdomain>.vm.cld.sr/vedsdk/authorize/\": x509: certificate is valid for tpp.venafidemo.com, not <subdomain>.vm.cld.sr
async function resolveDnsHostname(hostname: string){
    const lookup = util.promisify(dns.lookup);
    return await lookup(hostname);
}
const ip = pulumi.output(resolveDnsHostname(venafiTppEndpoint))

const certManager = new certmgr.CertManager("cert-manager", {
    namespaceName,
    helmChartVersion: "v1.0.3",
    provider: cluster.provider,
    hostAliases: <k8s.types.input.core.v1.HostAlias[]>[{ip: ip.address, hostnames: [venafiTppUrl]}],
});

const certMgrReady = certManager.chart.resources.apply(m => pulumi.all(m).apply(m => Object.values(m).map(r => pulumi.output(r))));

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
    {provider: cluster.provider},
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
    },{provider: cluster.provider}
);
const lbEndpoint = nginxSvc.status.loadBalancer.ingress.apply(ingress => ingress[0].hostname);

// =============================================================================
// Create a cert-manager Issuer and Certificate for the Demo App to use.
// =============================================================================

const regionName = pulumi.output(aws.getRegion({}, {async: true})).name;
const certMgrName = "cert-manager";
const secretName = "letsencrypt-cert"

// Create a Secret.
const secret = new k8s.core.v1.Secret("venafi-tpp-creds", {
    metadata: {namespace: namespaceName},
    stringData: {
        "username": config.require("venafiTppUsername"),
        "password": config.requireSecret("venafiTppPassword"),
    }
}, {provider: cluster.provider, dependsOn: certMgrReady});

// Create a Issuer for cert-manager in the namespace.
const issuer = new certmgr.crds.certmanager.v1.ClusterIssuer(certMgrName, {
    metadata: {name: certMgrName, annotations: {"webhook": webhookSvc.id}},
    spec: {
        venafi: {
            zone: venafiTppZone,
            tpp:{
                credentialsRef: {name: secret.metadata.name},
                url: venafiTppUrl,
            },
        },
    },
}, {provider: cluster.provider});

const certificate = new certmgr.crds.certmanager.v1.Certificate(certMgrName, {
    metadata: {namespace: namespaceName},
    spec: {
        secretName,
        commonName: certDnsNames[0],
        dnsNames: certDnsNames,
        issuerRef: {name: certMgrName, kind: issuer.kind},
    },
}, {provider: cluster.provider});

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
    {provider: cluster.provider},
);

// Create a Service for the kuard Deployment
const service = new k8s.core.v1.Service(appName,
    {
        metadata: {labels:appLabels, namespace: namespaceName},
        spec: {ports: [{ port: 8080, targetPort: "http" }], selector: appLabels},
    },
    {provider: cluster.provider}
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
    {provider: cluster.provider},
);
