{{- define "asa-workspace.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- define "asa-workspace.fullname" -}}
{{- if .Values.fullnameOverride }}{{ .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}{{- else }}{{ include "asa-workspace.name" . }}{{- end }}
{{- end }}
{{- define "asa-workspace.labels" -}}
app.kubernetes.io/name: {{ include "asa-workspace.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
{{- end }}
{{- define "asa-workspace.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}{{ default (include "asa-workspace.fullname" .) .Values.serviceAccount.name }}{{- else }}{{ required "serviceAccount.name is required when serviceAccount.create is false" .Values.serviceAccount.name }}{{- end }}
{{- end }}
{{- define "asa-workspace.postgresqlFullname" -}}
{{- if .Values.postgresql.fullnameOverride -}}
{{- .Values.postgresql.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else if .Values.postgresql.nameOverride -}}
{{- printf "%s-%s" .Release.Name .Values.postgresql.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-postgresql" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end }}
{{- define "asa-workspace.elasticsearchName" -}}
{{- default "elasticsearch" .Values.elasticsearch.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end }}
{{- define "asa-workspace.elasticsearchFullname" -}}
{{- if .Values.elasticsearch.fullnameOverride -}}
{{- .Values.elasticsearch.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else if .Values.elasticsearch.nameOverride -}}
{{- printf "%s-%s" .Release.Name .Values.elasticsearch.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-elasticsearch" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end }}
{{- define "asa-workspace.elasticsearchUrl" -}}
{{- printf "http://%s:9200" (include "asa-workspace.elasticsearchFullname" .) -}}
{{- end }}
{{- define "asa-workspace.warehouseEvidenceClaim" -}}
{{- if .Values.dataWarehouse.evidence.existingClaim -}}
{{- .Values.dataWarehouse.evidence.existingClaim -}}
{{- else -}}
{{- printf "%s-evidence" (include "asa-workspace.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end }}
{{- define "asa-workspace.warehouseNamespace" -}}
{{- default .Release.Namespace .Values.dataWarehouse.namespace -}}
{{- end }}
