def spec: if .kind == "Job" then .spec.template.spec.template.spec else .spec.template.spec end;
def annotations: .spec.template.metadata.annotations;
(spec) as $s |
(annotations) as $a |
($s.containers[0]) as $c |
($s.volumes[0]) as $v |
($c.volumeMounts[0]) as $m |
$s.serviceAccountName == "nearyou-prod-migration@nearnight.iam.gserviceaccount.com" and
$s.maxRetries == 0 and
$s.timeoutSeconds == "300" and
$c.image == $image and
$c.args == ["/var/run/secrets/nearyou/database-url"] and
($c.env | sort_by(.name)) == [
  {"name":"NEARYOU_GATEWAY_DATABASE_DISPOSABLE","value":"true"},
  {"name":"NEARYOU_GATEWAY_DATABASE_INSTANCE","value":"nearnight:us-central1:nearyou-evidence-20260820"}
] and
($s.volumes | length) == 1 and
($c.volumeMounts | length) == 1 and
$v.name == $m.name and
$m.mountPath == "/var/run/secrets/nearyou" and
$v.secret.secretName == "nf-rdy-disposable-migration-admin" and
$v.secret.items == [{"key":"2","path":"database-url"}] and
($a["run.googleapis.com/network-interfaces"] | fromjson) == [{"network":"nearyou-production","subnetwork":"nearyou-production"}] and
$a["run.googleapis.com/vpc-access-egress"] == "private-ranges-only"
