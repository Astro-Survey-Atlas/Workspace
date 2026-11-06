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
{{- define "asa-workspace.productionDataClaim" -}}
{{- if .Values.productionData.existingClaim -}}
{{- .Values.productionData.existingClaim -}}
{{- else -}}
{{- printf "%s-production-data" (include "asa-workspace.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end }}

{{- define "asa-workspace.searchName" -}}
{{- printf "%s-search" (include "asa-workspace.fullname" .) -}}
{{- end }}
{{- define "asa-workspace.stateClaim" -}}
{{- default (printf "%s-state" (include "asa-workspace.fullname" .)) .Values.persistence.existingClaim -}}
{{- end }}
{{- define "asa-workspace.runtimeEnv" -}}
- name: ASTRO_STATE_ROOT
  value: /state
- name: ASTRO_SQLITE_PATH
  value: /state/workspace.sqlite
- name: ASTRO_SCANS_PAUSED
  value: {{ .Values.scanner.paused | quote }}
- name: ASTRO_WORKSPACE_SCAN_ENABLED
  value: {{ .Values.scanner.enabled | quote }}
- name: ASTRO_ES_TIMEOUT_MS
  value: {{ .Values.search.timeoutMs | quote }}
- name: ASTRO_ES_URL
  {{- if eq .Values.search.mode "bundled" }}
  value: {{ printf "http://%s:9200" (include "asa-workspace.searchName" .) | quote }}
  {{- else if .Values.search.external.url }}
  value: {{ .Values.search.external.url | quote }}
  {{- else }}
  valueFrom:
    secretKeyRef:
      name: {{ .Values.search.external.existingSecret | quote }}
      key: {{ .Values.search.external.existingSecretKey | quote }}
  {{- end }}
{{- $roots := list "/state/coverage-downloads" }}
{{- if .Values.localData.enabled }}{{- $roots = append $roots "/data/local" }}{{- end }}
{{- if .Values.productionData.enabled }}{{- $roots = append $roots .Values.productionData.mountPath }}{{- end }}
- name: ASTRO_LOCAL_CONNECTOR_ROOTS
  value: {{ join ":" $roots | quote }}
{{- if .Values.productionData.enabled }}
- name: ASTRO_COVERAGE_DOWNLOAD_ROOT
  value: {{ .Values.productionData.mountPath | quote }}
- name: ASTRO_PRODUCTION_DATA_MOUNT
  value: {{ .Values.productionData.mountPath | quote }}
{{- end }}
{{- if .Values.networkProxy.enabled }}
- name: NODE_USE_ENV_PROXY
  value: "1"
- name: HTTP_PROXY
  value: {{ .Values.networkProxy.url | quote }}
- name: HTTPS_PROXY
  value: {{ .Values.networkProxy.url | quote }}
- name: NO_PROXY
  value: {{ append .Values.networkProxy.noProxy (include "asa-workspace.searchName" .) | uniq | join "," | quote }}
{{- end }}
{{- if .Values.telemetry.enabled }}
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: {{ .Values.telemetry.endpoint | quote }}
- name: OTEL_EXPORTER_OTLP_PROTOCOL
  value: http/protobuf
- name: K8S_POD_NAME
  valueFrom:
    fieldRef:
      fieldPath: metadata.name
- name: OTEL_RESOURCE_ATTRIBUTES
  value: {{ printf "asa.cluster=%s,deployment.environment=%s,k8s.namespace.name=%s,k8s.pod.name=$(K8S_POD_NAME)" .Values.telemetry.cluster .Values.telemetry.environment .Release.Namespace | quote }}
- name: OTEL_TRACES_SAMPLER
  value: parentbased_always_on
- name: OTEL_METRIC_EXPORT_INTERVAL
  value: {{ .Values.telemetry.metricExportIntervalMs | quote }}
- name: OTEL_METRICS_EXPORTER
  value: otlp
- name: OTEL_TRACES_EXPORTER
  value: otlp
- name: OTEL_LOGS_EXPORTER
  value: none
- name: OTEL_NODE_RESOURCE_DETECTORS
  value: env
- name: OTEL_PROPAGATORS
  value: tracecontext,baggage
- name: ASA_OTEL_CAPTURE_CONTENT
  value: "false"
{{- end }}
{{- with .Values.env }}
{{ toYaml . }}
{{- end }}
{{- end }}
{{- define "asa-workspace.mounts" -}}
- name: state
  mountPath: /state
- name: tmp
  mountPath: /tmp
{{- if .Values.productionData.enabled }}
- name: production-data
  mountPath: {{ .Values.productionData.mountPath | quote }}
{{- end }}
{{- if .Values.localData.enabled }}
- name: local-data
  mountPath: /data/local
  readOnly: true
{{- end }}
{{- end }}
{{- define "asa-workspace.volumes" -}}
- name: state
  {{- if .Values.persistence.enabled }}
  persistentVolumeClaim:
    claimName: {{ include "asa-workspace.stateClaim" . | quote }}
  {{- else }}
  emptyDir: {}
  {{- end }}
- name: tmp
  emptyDir: {}
{{- if .Values.productionData.enabled }}
- name: production-data
  persistentVolumeClaim:
    claimName: {{ include "asa-workspace.productionDataClaim" . | quote }}
{{- end }}
{{- if .Values.localData.enabled }}
- name: local-data
  {{- if .Values.localData.existingClaim }}
  persistentVolumeClaim:
    claimName: {{ .Values.localData.existingClaim | quote }}
    readOnly: true
  {{- else if .Values.localData.nfs.server }}
  nfs:
    server: {{ .Values.localData.nfs.server | quote }}
    path: {{ .Values.localData.nfs.path | quote }}
    readOnly: true
  {{- else }}
  hostPath:
    path: {{ .Values.localData.hostPath.path | quote }}
    type: Directory
  {{- end }}
{{- end }}
{{- end }}
