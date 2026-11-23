// Generate independent, synthetic OCSP request and revocation evidence fixtures.
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
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

func main() {
	at := time.Now().UTC().Truncate(time.Minute).Add(5 * time.Minute)
	ca := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Discovery fixture issuer"},
		NotBefore: at.AddDate(-1, 0, 0), NotAfter: at.AddDate(1, 0, 0),
		BasicConstraintsValid: true, IsCA: true,
		KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
	}
	caKey := must(ecdsa.GenerateKey(elliptic.P256(), rand.Reader))
	issuer := must(x509.ParseCertificate(must(x509.CreateCertificate(rand.Reader, ca, ca, &caKey.PublicKey, caKey))))
	leaf := &x509.Certificate{
		SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "Discovery fixture signer"},
		NotBefore: ca.NotBefore, NotAfter: ca.NotAfter, KeyUsage: x509.KeyUsageDigitalSignature,
		OCSPServer: []string{
			"https://denied.test/check", "https://revocation.test:first@revocation.test/credentials",
			"https://127.0.0.1/check", "https://[::1]/check", "https://local.local/check",
			"http://legacy.test/check", "ftp://revocation.test/check",
			"https://revocation.test/ocsp", "https://REVOCATION.test:443/ocsp", "https://revocation.test/ocsp2",
		},
		IssuingCertificateURL: []string{"https://revocation.test/issuer"},
		CRLDistributionPoints: []string{"https://revocation.test/crl", "https://revocation.test/crl2"},
	}
	leafKey := must(ecdsa.GenerateKey(elliptic.P256(), rand.Reader))
	target := must(x509.ParseCertificate(must(x509.CreateCertificate(rand.Reader, leaf, issuer, &leafKey.PublicKey, caKey))))
	response := func(start, end time.Time, serial int64) []byte {
		return must(ocsp.CreateResponse(issuer, issuer, ocsp.Response{
			Status: ocsp.Good, SerialNumber: big.NewInt(serial), ThisUpdate: start, NextUpdate: end,
		}, caKey))
	}
	start, end := at.Add(-time.Hour), at.Add(time.Hour)
	crl := must(x509.CreateRevocationList(rand.Reader, &x509.RevocationList{
		Number: big.NewInt(1), ThisUpdate: start, NextUpdate: end,
		RevokedCertificateEntries: []x509.RevocationListEntry{{SerialNumber: target.SerialNumber, RevocationTime: start}},
	}, issuer, caKey))
	output := map[string]any{
		"at": at, "issuer": issuer.Raw, "leaf": target.Raw,
		// Public, throwaway fixture key so tests can create PDFs with this leaf.
		"fixtureKey": must(x509.MarshalPKCS8PrivateKey(leafKey)),
		"request":    must(ocsp.CreateRequest(target, issuer, nil)),
		"goodOcsp":   response(start, end, leaf.SerialNumber.Int64()),
		"staleOcsp":  response(start.Add(-time.Hour), start, leaf.SerialNumber.Int64()),
		"wrongOcsp":  response(start, end, 100),
		"crl":        crl,
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(output); err != nil {
		panic(err)
	}
}
