# Deploying Cert-Manager with Pulumi and Kubernetes

cert-manager automates certificate management in cloud native environments. It
builds on top of Kubernetes, introducing certificate authorities and
certificates as first-class resource types in the Kubernetes API. This makes it
possible to provide 'certificates as a service' to developers working within
your Kubernetes cluster.

## Pulumi ComponentResource

The [cert-manager](./cert-manager) Pulumi [ComponentResource](https://www.pulumi.com/docs/intro/concepts/programming-model/#resources) encapsulates
deploying cert-manager on Kubernetes, as well as includes the necessary
Kubernetes [CRDs](./cert-manager/crds/nodejs) needed to provision certificates
as strongly-typed resources in Pulumi.

## Examples

The following are examples of using different certificate issuer types and
securing an application deployment analogus to the tutorials for [Securing
Ingresses with Venafi](https://cert-manager.io/docs/tutorials/venafi/venafi/)
as well as [Securing Ingresses with
LetsEncrypt](https://cert-manager.io/docs/tutorials/acme/ingress/).

Each example walks you through a tutorial of how to deploy the Pulumi stack to
work with the issuer of your choice, as well as includes an example of a policy enforced
deployment approach that verifies the issuer type used is of type Venafi or
ACME.

1. [Secure an app using LetsEncrypt](./examples/letsencrypt)
1. [Secure an app using Venafi TPP](./examples/venafi-tpp)
1. [Secure an app using Venafi Cloud](./examples/venafi-cloud)
