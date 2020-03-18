#!/usr/bin/env bash
set -euf -o pipefail

SECRETS_DIR="k8s/overlays/dev/secrets"

mkdir -p ${SECRETS_DIR}

openssl genrsa \
    -des3 -passout pass:xxxx -out ${SECRETS_DIR}/tls.pass.key 2048

openssl rsa \
    -passin pass:xxxx -in ${SECRETS_DIR}/tls.pass.key -out ${SECRETS_DIR}/tls.key

openssl req \
    -new -key ${SECRETS_DIR}/tls.key -out ${SECRETS_DIR}/tls.csr \
    -subj "//C=US/ST=California/L=Pasadena/O=KubeSail/OU=Agent/CN=kubesail-gateway"

openssl x509 \
    -req -sha256 -days 365 -in ${SECRETS_DIR}/tls.csr -signkey ${SECRETS_DIR}/tls.key -out ${SECRETS_DIR}/tls.crt

rm ${SECRETS_DIR}/tls.pass.key
