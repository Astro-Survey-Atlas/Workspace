{{- define "astro-data-workspace.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- define "astro-data-workspace.fullname" -}}
{{- if .Values.fullnameOverride }}{{ .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}{{- else }}{{ include "astro-data-workspace.name" . }}{{- end }}
{{- end }}
{{- define "astro-data-workspace.labels" -}}
app.kubernetes.io/name: {{ include "astro-data-workspace.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
{{- end }}
{{- define "astro-data-workspace.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}{{ default (include "astro-data-workspace.fullname" .) .Values.serviceAccount.name }}{{- else }}{{ required "serviceAccount.name is required when serviceAccount.create is false" .Values.serviceAccount.name }}{{- end }}
{{- end }}
{{- define "astro-data-workspace.postgresqlFullname" -}}
{{- if .Values.postgresql.fullnameOverride -}}
{{- .Values.postgresql.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else if .Values.postgresql.nameOverride -}}
{{- printf "%s-%s" .Release.Name .Values.postgresql.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-postgresql" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end }}
{{- define "astro-data-workspace.elasticsearchName" -}}
{{- default "elasticsearch" .Values.elasticsearch.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end }}
{{- define "astro-data-workspace.elasticsearchFullname" -}}
{{- if .Values.elasticsearch.fullnameOverride -}}
{{- .Values.elasticsearch.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else if .Values.elasticsearch.nameOverride -}}
{{- printf "%s-%s" .Release.Name .Values.elasticsearch.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-elasticsearch" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end }}
{{- define "astro-data-workspace.elasticsearchUrl" -}}
{{- printf "http://%s:9200" (include "astro-data-workspace.elasticsearchFullname" .) -}}
{{- end }}
