{{- define "apim.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "apim.labels" -}}
app.kubernetes.io/part-of: otoroshi-api-management
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "apim.secretName" -}}
{{- default (include "apim.fullname" .) .Values.secrets.existingSecret -}}
{{- end -}}

{{/* the variables both deployments read */}}
{{- define "apim.env" -}}
- { name: APIM_DATABASE_URL, valueFrom: { secretKeyRef: { name: {{ include "apim.secretName" . }}, key: database-url } } }
- { name: APIM_ANALYTICS_DATABASE_URL, valueFrom: { secretKeyRef: { name: {{ include "apim.secretName" . }}, key: analytics-database-url } } }
- { name: OTOROSHI_CLIENT_ID, valueFrom: { secretKeyRef: { name: {{ include "apim.secretName" . }}, key: otoroshi-client-id } } }
- { name: OTOROSHI_CLIENT_SECRET, valueFrom: { secretKeyRef: { name: {{ include "apim.secretName" . }}, key: otoroshi-client-secret } } }
- { name: APIM_BOOTSTRAP_PASSWORD, valueFrom: { secretKeyRef: { name: {{ include "apim.secretName" . }}, key: bootstrap-password } } }
- { name: APIM_SECRETS_KEY, valueFrom: { secretKeyRef: { name: {{ include "apim.secretName" . }}, key: secrets-key } } }
- { name: APIM_SECRETS_PREVIOUS_KEYS, valueFrom: { secretKeyRef: { name: {{ include "apim.secretName" . }}, key: secrets-previous-keys, optional: true } } }
{{- end -}}

{{/* the environment both deployments load: the ConfigMap, the secret variables of the values, the sources named */}}
{{- define "apim.envFrom" -}}
- configMapRef: { name: {{ include "apim.fullname" . }} }
{{- if .Values.secrets.extraEnv }}
- secretRef: { name: {{ include "apim.fullname" . }}-env }
{{- end }}
{{- with .Values.extraEnvFrom }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/* a change of the configuration or of the secrets the chart makes restarts the pods */}}
{{- define "apim.checksums" -}}
checksum/config: {{ include (print .Template.BasePath "/configmap.yaml") . | sha256sum }}
checksum/secret: {{ include (print .Template.BasePath "/secret.yaml") . | sha256sum }}
{{- end -}}
