def label = "jenkins-slave-${UUID.randomUUID().toString()}"
def project = 'kubesail'

podTemplate(label: label, yaml: """
apiVersion: v1
kind: Pod
metadata:
  namespace: jenkins-kubesail
labels:
  component: ci
spec:
  nodeSelector:
    kubernetes.io/hostname: ip-10-0-1-126
  containers:
  - name: builder
    image: kubesail/jenkins-slave:v13
    imagePullPolicy: IfNotPresent
    command:
    - cat
    tty: true
    env:
    - name: GET_HOSTS_FROM
      value: dns
    - name: DOCKER_HOST
      value: tcp://jenkins-dind:2375
    resources:
      requests:
        cpu: 2
        memory: 4000Mi
      limits:
        cpu: 7
        memory: 12000Mi
"""
  ) {
  node(label) {
    properties([disableConcurrentBuilds()])
    checkout scm
    container('builder') {
      ansiColor('linux') {
        timeout(30) {
          environment {
            DOCKER_HUB_CREDS = credentials('dockerhub')
          }

          withCredentials([usernamePassword(credentialsId: 'dockerhub', passwordVariable: 'DOCKER_HUB_CREDS_PASS', usernameVariable: 'DOCKER_HUB_CREDS_USER')]) {
              sh "docker login --username $DOCKER_HUB_CREDS_USER --password $DOCKER_HUB_CREDS_PASS"
          }

          sh "docker build -t kubesail/agent:${env.BRANCH_NAME} ."

          if (env.BRANCH_NAME == 'master') {
            sh "docker push kubesail/agent:${env.BRANCH_NAME}"
          }

        }
      }
    }
  }
}
