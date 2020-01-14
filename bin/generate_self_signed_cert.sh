#!/usr/bin/env bash
set -e

mkdir -p secrets

openssl genrsa \
    -des3 -passout pass:xxxx -out secrets/tls.pass.key 2048

openssl rsa \
    -passin pass:xxxx -in secrets/tls.pass.key -out secrets/tls.key.pem

openssl req \
    -new -key secrets/tls.key.pem -out secrets/tls.csr.pem \
    -subj "//C=US/ST=California/L=Pasadena/O=KubeSail/OU=Agent/CN=kubesail-gateway"

openssl x509 \
    -req -sha256 -days 365 -in secrets/tls.csr.pem -signkey secrets/tls.key.pem -out secrets/tls.crt.pem

rm secrets/tls.pass.key
