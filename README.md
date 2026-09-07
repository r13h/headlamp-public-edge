# DNS & PublicEdge Headlamp plugin

Read-only DNS publication and topology console for PublicEdgeManager. It
collects domains declared by existing Ingress and HTTPRoute resources, their
ExternalDNS targets, selected public exits, backend Services and Pod nodes. It
also inventories every in-cluster Service exposing UDP port 53, so authoritative
DNS endpoints and application publication paths are visible on one page.

The page remains useful before PublicEdgeManager or Gateway API is enabled:
Ingress-backed hostnames are shown and unmanaged DNS is clearly marked. The
plugin never patches DNS or routing; GitOps remains the write path.

The GZSJ build groups duplicate Ingress and HTTPRoute declarations by hostname
and maps each hostname to its authoritative zone and provider. Alibaba Cloud DNS
and Tencent Cloud DNSPod zones are shown as `Dry run` until their ExternalDNS
controllers are explicitly promoted; the ESA-managed zone remains `External`.
Scrollable zone tabs separate each root domain. For ExternalDNS zones, ownership
is derived from the live Flux HelmRelease: suspended, not ready, dry-run, or
managed. It is not a hard-coded claim of DNS control.

The plugin requires read access to `PublicEdge`, `HTTPRoute`, `Ingress`, `Pod`
and `EndpointSlice` resources.
