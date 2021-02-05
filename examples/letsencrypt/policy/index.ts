import * as certmgr from "../../../cert-manager";
import { EnforcementLevel, PolicyPack, ResourceValidationPolicy, validateResourceOfType } from "@pulumi/policy";

const policies = new PolicyPack("kubernetes", {
    policies: [
        validIssuerTypeUsed("mandatory"),
        validClusterIssuerTypeUsed("mandatory"),
        // validDnsName("mandatory")
    ],
});

function validIssuerTypeUsed(enforcementLevel: EnforcementLevel): ResourceValidationPolicy {
    return {
        name: "cert-manager-no-invalid-issuer-type",
        description: "cert-manager Issuer type should be of type Venafi or ACME",
        enforcementLevel: enforcementLevel,
        validateResource: validateResourceOfType(certmgr.crds.certmanager.v1.Issuer, (issuer, _, reportViolation) => {
            if (issuer.spec?.venafi != undefined &&
                issuer.spec?.acme != undefined){
                reportViolation(
                    "You cannot set a cert-manager Issuer with a type other than Venafi or ACME"
                )
            }
        }),
    };
}

function validClusterIssuerTypeUsed(enforcementLevel: EnforcementLevel): ResourceValidationPolicy {
    return {
        name: "cert-manager-no-invalid-cluster-issuer-type",
        description: "cert-manager ClusterIssuer type should be of type Venafi or ACME",
        enforcementLevel: enforcementLevel,
        validateResource: validateResourceOfType(certmgr.crds.certmanager.v1.ClusterIssuer, (clusterIssuer, _, reportViolation) => {
            if (clusterIssuer.spec?.venafi != undefined &&
                clusterIssuer.spec?.acme != undefined){
                reportViolation(
                    "You cannot set a cert-manager ClusterIssuer with a type other than Venafi or ACME"
                )
            }
        }),
    };
}

function validDnsName(enforcementLevel: EnforcementLevel): ResourceValidationPolicy {
    return {
        name: "cert-manager-valid-dns-name",
        description: "cert-manager certificates should have the correct dns name",
        enforcementLevel: enforcementLevel,
        validateResource: validateResourceOfType(certmgr.crds.certmanager.v1.Certificate, (cert, _, reportViolation) => {
            cert.spec?.dnsNames?.forEach( (name) => {
                // split the name on the "."
                let splitDnsName = name.split(".")
                if ( splitDnsName[1] != "pulumi-demos" && splitDnsName[2] != ".net") {
                    reportViolation(
                        "certificates must be issues to *.pulumi-demos.net"
                    )
                }
            })
        }),
    };
}
