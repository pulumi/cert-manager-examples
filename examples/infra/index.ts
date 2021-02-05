import * as pulumi from "@pulumi/pulumi";
import * as eks from "@pulumi/eks";

const projectName = pulumi.getProject();

// =============================================================================
// Create an EKS cluster with an OIDC provider.
// =============================================================================

const cluster = new eks.Cluster(`${projectName}`, {
    createOidcProvider: true,
    tags: {
        Owner: "lbriggs",
        owner: "lbriggs"
    }
});

// Export the cluster's kubeconfig.
export const kubeconfig = cluster.kubeconfig;

// Check for the cluster OIDC provider to use per-Pod IAM.
if (!cluster?.core?.oidcProvider) {
    throw new Error("Invalid cluster OIDC provider URL");
}

export const oidcProviderArn = cluster.core.oidcProvider.arn
export const oidcProviderUrl = cluster.core.oidcProvider.url
