#!/usr/bin/env bash
set -euf -o pipefail

echo -e "\nESLINT:"
yarn run eslint --resolve-plugins-relative-to . --config .eslintrc.json "$@" lib

echo -e "\nLint OK"
