#!/bin/bash

if [[ $NODE_ENV == "development" ]]; then
  echo "Starting in DEVELOPMENT mode"
  ./node_modules/.bin/nodemon --watch lib --ext js,json,yaml,plain -- --inspect=0.0.0.0:9229 --stack_size=1200 $@
else
  node --stack_size=1200 $@
fi
