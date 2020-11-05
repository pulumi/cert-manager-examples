import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as aws from "@pulumi/aws";

// Create the AWS IAM policy and role for the Kubernetes Service Account to
// configure DNS in AWS Route53.
export function CreateServiceAccountIAMRole(
    name: string,
    namespaceName: pulumi.Input<string>,
    clusterOidcProviderArn: pulumi.Input<string>,
    clusterOidcProviderUrl: pulumi.Input<string>): aws.iam.Role
{
    // Create the IAM target policy and role for the Service Account.
    const saAssumeRolePolicy = pulumi.all([clusterOidcProviderUrl, clusterOidcProviderArn, namespaceName]).apply(([url, arn, namespace]) => aws.iam.getPolicyDocument({
        statements: [{
            actions: ["sts:AssumeRoleWithWebIdentity"],
            conditions: [{
                test: "StringEquals",
                values: [`system:serviceaccount:${namespace}:${name}`],
                variable: `${url.replace("https://", "")}:sub`,
            }],
            effect: "Allow",
            principals: [{
                identifiers: [arn],
                type: "Federated",
            }],
        }],
    }));

    const saRole = new aws.iam.Role(name, {
        assumeRolePolicy: saAssumeRolePolicy.json,
    });
    
    const policy = new aws.iam.Policy(name, {
        description: "Allows cert-manager add records to Route53 in order to solve the DNS01 challenge",
        policy: JSON.stringify(
            {
                "Version": "2012-10-17",
                "Statement": [
                    {
                        "Effect": "Allow",
                        "Action": "route53:GetChange",
                        "Resource": "arn:aws:route53:::change/*"
                    },
                    {
                        "Effect": "Allow",
                        "Action": [
                            "route53:ChangeResourceRecordSets",
                            "route53:ListResourceRecordSets"
                        ],
                        "Resource": "arn:aws:route53:::hostedzone/*"
                    },
                    {
                        "Effect": "Allow",
                        "Action": "route53:ListHostedZonesByName",
                        "Resource": "*"
                    }
                ]
            }
        )
    });

    // Attach the policy to the role for the service account.
    const rpa = new aws.iam.RolePolicyAttachment(name, {
        policyArn: policy.arn,
        role: saRole,
    });

    return saRole;
}

// Create a ServiceAccount with the annotated role ARN that has permissions to
// configure DNS in AWS Route53.
export function CreateServiceAccount(
    name: string,
    provider: k8s.Provider,
    roleArn: pulumi.Input<aws.ARN>,
    namespaceName: pulumi.Input<string>): k8s.core.v1.ServiceAccount
{
    return new k8s.core.v1.ServiceAccount(name, {
        metadata: {
            namespace: namespaceName,
            name: name,
            annotations: {
                "eks.amazonaws.com/role-arn": roleArn,
            },
        },
    }, { provider: provider },
)}
