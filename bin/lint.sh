#!/usr/bin/env bash
set -euf -o pipefail

echo -e "\nESLINT:"
./node_modules/.bin/eslint --resolve-plugins-relative-to . --config .eslintrc.json "$@" lib

echo -e "\nLint OK"
