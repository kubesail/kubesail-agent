#!/usr/bin/env bash
set -e

echo -e "\nESLINT:"
./node_modules/.bin/eslint "$@" lib

echo -e "\nFlow:"
./node_modules/.bin/flow check

echo -e "\nLint OK"
