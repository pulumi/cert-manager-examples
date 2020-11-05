import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export type CertManagerOptions = {
    replicas?: pulumi.Input<number>;
    namespaceName: pulumi.Input<string>;
    helmChartVersion: pulumi.Input<string>;
    provider: k8s.Provider;
    iamRoleArn?: pulumi.Input<string>;
    hostAliases?: k8s.types.input.core.v1.HostAlias[];
};

const pulumiComponentNamespace: string = "pulumi:CertManager";

export class CertManager extends pulumi.ComponentResource {
    public readonly chart: k8s.helm.v3.Chart;
    constructor(
        name: string,
        args: CertManagerOptions,
        opts?: pulumi.ComponentResourceOptions,
    ) {
        super(pulumiComponentNamespace, name, args, opts);
        this.chart = newCertManager(name, args)
    }
}

export function newCertManager(
    name: string,
    args: CertManagerOptions): k8s.helm.v3.Chart
{
    return new k8s.helm.v3.Chart(name,
        {
            namespace: args.namespaceName,
            chart: "cert-manager",
            version: args.helmChartVersion || "v1.0.3",
            fetchOpts: {
                repo: "https://charts.jetstack.io",
            },
            values: {
                replicaCount: args.replicas || 2,
                installCRDs: true,
                serviceAccount: args.iamRoleArn ? { annotations: {"eks.amazonaws.com/role-arn": args.iamRoleArn}} : undefined,
                securityContext: {
                    fsGroup: 1001,
                    runAsUser: 1001,
                },
            },
            transformations: [(obj: any) => {
                if (obj.kind === "Deployment" && obj.metadata.name === "cert-manager") {
                    obj.spec.template.spec.hostAliases = args.hostAliases;
                }
            }],
        }, {provider: args.provider, dependsOn: args.provider},
    );
}
