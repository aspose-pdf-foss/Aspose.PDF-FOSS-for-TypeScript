// Generate public synthetic revocation fixtures using Go's X.509 and OCSP writers.
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/json"
	"math/big"
	"os"
	"time"

	"golang.org/x/crypto/ocsp"
)

func must[T any](value T, err error) T {
	if err != nil {
		panic(err)
	}
	return value
}

type identity struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
}

func main() {
	at := time.Now().UTC().Truncate(time.Minute).Add(time.Minute)
	serial := int64(0)
	year := 365 * 24 * time.Hour
	issue := func(name string, parent identity, usage x509.KeyUsage, eku []x509.ExtKeyUsage, ca bool, validFor time.Duration) identity {
		serial++
		key := must(ecdsa.GenerateKey(elliptic.P256(), rand.Reader))
		template := &x509.Certificate{
			SerialNumber: big.NewInt(serial), Subject: pkix.Name{CommonName: name},
			NotBefore: at.Add(-year), NotAfter: at.Add(validFor),
			KeyUsage: usage, ExtKeyUsage: eku, IsCA: ca, BasicConstraintsValid: true,
		}
		if parent.cert == nil {
			parent = identity{template, key}
		}
		return identity{must(x509.ParseCertificate(must(x509.CreateCertificate(rand.Reader, template, parent.cert, &key.PublicKey, parent.key)))), key}
	}
	caUsage := x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature
	issuer := issue("Fixture CA", identity{}, caUsage, nil, true, year)
	other := issue("Fixture CA", identity{}, caUsage, nil, true, year)
	leaf := issue("Fixture signer", issuer, x509.KeyUsageDigitalSignature, nil, false, year)
	expiredLeaf := issue("Fixture expired signer", issuer, x509.KeyUsageDigitalSignature, nil, false, -2*time.Hour)
	ocspUsage := []x509.ExtKeyUsage{x509.ExtKeyUsageOCSPSigning}
	delegate := issue("Fixture OCSP", issuer, x509.KeyUsageDigitalSignature, ocspUsage, false, year)
	expired := issue("Fixture expired OCSP", issuer, x509.KeyUsageDigitalSignature, ocspUsage, false, -30*time.Second)
	tlsOnly := issue("Fixture TLS", issuer, x509.KeyUsageDigitalSignature, []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, false, year)
	// An alternate certificate for the same issuer key lacks cRLSign. The CRL
	// itself is generated under the original, permitted issuer certificate.
	issuerWithoutUsage := *issuer.cert
	issuerWithoutUsage.KeyUsage = x509.KeyUsageCertSign
	issuerWithoutUsage.SerialNumber = big.NewInt(1000)
	noCrlIssuer := must(x509.CreateCertificate(rand.Reader, &issuerWithoutUsage, &issuerWithoutUsage, &issuer.key.PublicKey, issuer.key))

	response := func(target identity, responder identity, start, next time.Time, status int) []byte {
		return must(ocsp.CreateResponse(issuer.cert, responder.cert, ocsp.Response{
			SerialNumber: target.cert.SerialNumber, Status: status, ThisUpdate: start,
			NextUpdate: next, RevokedAt: start, Certificate: responder.cert,
		}, responder.key))
	}
	crl := func(signer identity, start, next time.Time, entries []x509.RevocationListEntry, extensions []pkix.Extension) []byte {
		return must(x509.CreateRevocationList(rand.Reader, &x509.RevocationList{
			Number: big.NewInt(1), ThisUpdate: start, NextUpdate: next,
			RevokedCertificateEntries: entries, ExtraExtensions: extensions,
		}, signer.cert, signer.key))
	}
	goodFrom, goodUntil := at.Add(-time.Hour), at.Add(time.Hour)
	revoked := []x509.RevocationListEntry{{SerialNumber: leaf.cert.SerialNumber, RevocationTime: goodFrom}}
	// onlyContainsCACerts = TRUE, encoded as the RFC's implicit [2] BOOLEAN.
	scope := []pkix.Extension{{Id: asn1.ObjectIdentifier{2, 5, 29, 28}, Critical: true, Value: []byte{0x30, 3, 0x82, 1, 0xff}}}
	output := map[string]any{
		"at": at, "issuer": issuer.cert.Raw, "otherIssuer": other.cert.Raw, "leaf": leaf.cert.Raw,
		"expiredLeaf":         expiredLeaf.cert.Raw,
		"noCrlIssuer":         noCrlIssuer,
		"issuerOcsp":          response(leaf, issuer, goodFrom, goodUntil, ocsp.Good),
		"delegateOcsp":        response(leaf, delegate, goodFrom, goodUntil, ocsp.Revoked),
		"tlsOnlyOcsp":         response(leaf, tlsOnly, goodFrom, goodUntil, ocsp.Good),
		"expiredDelegateOcsp": response(leaf, expired, goodFrom, goodUntil, ocsp.Good),
		"otherCertOcsp":       response(delegate, issuer, goodFrom, goodUntil, ocsp.Good),
		"staleOcsp":           response(leaf, issuer, at.Add(-2*time.Hour), goodFrom, ocsp.Good),
		"freshNoNextOcsp":     response(leaf, issuer, goodFrom, time.Time{}, ocsp.Good),
		"staleNoNextOcsp":     response(leaf, issuer, at.Add(-48*time.Hour), time.Time{}, ocsp.Good),
		"goodCrl":             crl(issuer, goodFrom, goodUntil, nil, nil),
		"revokedCrl":          crl(issuer, goodFrom, goodUntil, revoked, nil),
		"staleCrl":            crl(issuer, at.Add(-2*time.Hour), goodFrom, nil, nil),
		"scopedCrl":           crl(issuer, goodFrom, goodUntil, nil, scope),
		"wrongIssuerCrl":      crl(other, goodFrom, goodUntil, nil, nil),
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(output); err != nil {
		panic(err)
	}
}
