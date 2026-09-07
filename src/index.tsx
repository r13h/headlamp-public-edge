import { K8s, registerRoute, registerSidebarEntry } from '@kinvolk/headlamp-plugin/lib';
import { SectionBox, StatusLabel, Table } from '@kinvolk/headlamp-plugin/lib/components/common';
import { makeCustomResourceClass } from '@kinvolk/headlamp-plugin/lib/lib/k8s/crd';
import { Alert, Box, Chip, Typography } from '@mui/material';

const PublicEdge = makeCustomResourceClass({apiInfo:[{group:'networking.re8ch.com',version:'v1alpha1'}],kind:'PublicEdge',pluralName:'publicedges',singularName:'publicedge',isNamespaced:false});
const HTTPRoute = K8s.ResourceClasses.HTTPRoute;

const dnsZones = [
  {zone:'gzsijie.com', provider:'Alibaba Cloud ESA DNS', mode:'External'},
  {zone:'gzsijie.cn', provider:'Alibaba Cloud DNS', mode:'Dry run'},
  {zone:'mzlumora.com', provider:'Alibaba Cloud DNS', mode:'Dry run'},
  {zone:'andypy.com', provider:'Tencent Cloud DNSPod', mode:'Dry run'},
  {zone:'andy4576.com', provider:'Tencent Cloud DNSPod', mode:'Dry run'},
];

function zoneFor(host:string) {
  return dnsZones.find(({zone})=>host===zone || host.endsWith(`.${zone}`));
}

function combine(values:string[]) {
  const items=[...new Set(values.flatMap(splitNames).filter(x=>x && x!=='-'))];
  return items.join(', ') || '-';
}

function condition(item:any, type:string) {
  return item.status?.conditions?.find((x:any)=>x.type===type)?.status === 'True';
}

function annotation(item:any, key:string) {
  return item?.metadata?.annotations?.[key] || '';
}

function splitNames(value:string) {
  return value.split(',').map(x=>x.trim()).filter(Boolean);
}

function ingressTargets(ingress:any) {
  const explicit=annotation(ingress,'external-dns.alpha.kubernetes.io/target');
  if (explicit) return explicit;
  return (ingress.status?.loadBalancer?.ingress || []).map((x:any)=>x.hostname || x.ip).filter(Boolean).join(', ') || '-';
}

function ingressBackends(ingress:any) {
  const namespace=ingress.metadata?.namespace || 'default';
  const refs=(ingress.spec?.rules || []).flatMap((rule:any)=>(rule.http?.paths || []).map((path:any)=>path.backend?.service).filter(Boolean));
  return refs.map((ref:any)=>`${namespace}/${ref.name}:${ref.port?.number || ref.port?.name || '-'}`).join(', ') || '-';
}

function Dashboard() {
  const [edges, edgeError] = PublicEdge.useList({} as any);
  const [routes, routeError] = HTTPRoute.useList({} as any);
  const [pods] = K8s.ResourceClasses.Pod.useList({} as any);
  const [slices] = K8s.ResourceClasses.EndpointSlice.useList({} as any);
  const [ingresses, ingressError] = K8s.ResourceClasses.Ingress.useList({} as any);
  const [services, serviceError] = K8s.ResourceClasses.Service.useList({} as any);
  const podByIp = new Map((pods || []).filter((x:any)=>x.status?.podIP).map((x:any)=>[x.status.podIP,x]));

  const ingressRows=(ingresses || []).flatMap((ingress:any)=>{
    const ruleHosts=(ingress.spec?.rules || []).map((rule:any)=>rule.host).filter(Boolean);
    const annotatedHosts=splitNames(annotation(ingress,'external-dns.alpha.kubernetes.io/hostname'));
    return [...new Set([...ruleHosts,...annotatedHosts])].map((host:any)=>({
      host,
      source:`Ingress ${ingress.metadata?.namespace || 'default'}/${ingress.metadata?.name}`,
      target:ingressTargets(ingress),
      edge:annotation(ingress,'networking.re8ch.com/selected-public-edge') || '-',
      path:'Ingress controller',
      backends:ingressBackends(ingress),
      nodes:'-',
      state:(ingress.status?.loadBalancer?.ingress || []).length ? 'Published' : 'Configured',
      managed:Boolean(annotatedHosts.length),
    }));
  });

  const routeRows=(routes || []).filter((x:any)=>x.spec?.hostnames?.length).flatMap((route:any)=>(route.spec.hostnames || []).map((host:string)=>{
    const authority=(ingresses || []).find((x:any)=>splitNames(annotation(x,'external-dns.alpha.kubernetes.io/hostname')).includes(host));
    const refs=(route.spec.rules || []).flatMap((r:any)=>r.backendRefs || []);
    const backends=refs.map((b:any)=>`${route.metadata.namespace}/${b.name}:${b.port}`).join(', ') || '-';
    const backendNames=new Set(refs.map((b:any)=>b.name));
    const endpointIPs=(slices || []).filter((s:any)=>s.metadata?.namespace===route.metadata.namespace && backendNames.has(s.metadata?.labels?.['kubernetes.io/service-name'])).flatMap((s:any)=>(s.endpoints || []).filter((e:any)=>e.conditions?.ready!==false).flatMap((e:any)=>e.addresses || []));
    const nodes=[...new Set(endpointIPs.map((ip:string)=>podByIp.get(ip)?.spec?.nodeName).filter(Boolean))].join(', ') || '-';
    const parents=(route.spec.parentRefs || []).map((p:any)=>`${p.namespace || route.metadata.namespace}/${p.name}#${p.sectionName || '*'}`).join(' → ') || '-';
    const accepted=(route.status?.parents || []).some((p:any)=>(p.conditions || []).some((c:any)=>c.type==='Accepted'&&c.status==='True'));
    return {host,source:`HTTPRoute ${route.metadata.namespace}/${route.metadata.name}`,target:authority ? ingressTargets(authority) : '-',edge:annotation(authority,'networking.re8ch.com/selected-public-edge') || '-',path:parents,backends,nodes,state:accepted ? 'Accepted' : 'Problem',managed:Boolean(authority)};
  }));

  const discoveredRows=[...ingressRows,...routeRows];
  const domainRows=[...new Set(discoveredRows.map((row:any)=>row.host))].map(host=>{
    const rows=discoveredRows.filter((row:any)=>row.host===host);
    const zone=zoneFor(host);
    return {
      host,
      zone:zone?.zone || 'Unknown',
      provider:zone?.provider || 'Unassigned',
      mode:zone?.mode || 'Unmanaged',
      source:combine(rows.map((row:any)=>row.source)),
      target:combine(rows.map((row:any)=>row.target)),
      edge:combine(rows.map((row:any)=>row.edge)),
      path:combine(rows.map((row:any)=>row.path)),
      backends:combine(rows.map((row:any)=>row.backends)),
      nodes:combine(rows.map((row:any)=>row.nodes)),
      declarations:rows.length,
    };
  }).sort((a:any,b:any)=>a.zone.localeCompare(b.zone) || a.host.localeCompare(b.host));
  const dnsRows=(services || []).filter((service:any)=>(service.spec?.ports || []).some((port:any)=>port.port===53 && port.protocol==='UDP')).map((service:any)=>({
    name:`${service.metadata?.namespace || 'default'}/${service.metadata?.name}`,
    type:service.spec?.type || 'ClusterIP',
    clusterIP:service.spec?.clusterIP || '-',
    external:(service.status?.loadBalancer?.ingress || []).map((x:any)=>x.hostname || x.ip).filter(Boolean).join(', ') || service.spec?.externalIPs?.join(', ') || '-',
    ports:(service.spec?.ports || []).filter((port:any)=>port.port===53).map((port:any)=>`${port.port}/${port.protocol}`).join(', '),
  }));

  return <Box sx={{p:2}}>
    <Typography variant="h4">DNS & Public Edge</Typography>
    <Typography color="text.secondary">统一查看域名来源、解析目标、公网出口、Gateway/Ingress、后端 Service 与 UDP/53 DNS 服务。配置写入仍由 GitOps 管理。</Typography>
    {(ingressError || serviceError) && <Alert severity="error">无法读取基础网络资源：{String(ingressError || serviceError)}</Alert>}
    {(edgeError || routeError) && <Alert severity="info">PublicEdge 或 Gateway API 尚未启用；现有 Ingress 域名仍会正常汇总。</Alert>}
    <SectionBox title={`Domains (${domainRows.length})`}>
      <Table data={domainRows} columns={[
        {header:'Hostname',accessorKey:'host'},
        {header:'DNS zone',accessorKey:'zone'},
        {header:'Provider',accessorKey:'provider'},
        {header:'DNS ownership',accessorFn:(x:any)=><StatusLabel status={x.mode==='Dry run'?'warning':x.mode==='External'?'info':'error'}>{x.mode}</StatusLabel>},
        {header:'Declared by',accessorFn:(x:any)=>`${x.source}${x.declarations > 1 ? ` (${x.declarations})` : ''}`},
        {header:'DNS target',accessorKey:'target'},
        {header:'Selected exit',accessorKey:'edge'},
        {header:'Traffic path',accessorKey:'path'},
        {header:'Backend service',accessorKey:'backends'},
        {header:'Pod nodes',accessorKey:'nodes'},
      ] as any}/>
    </SectionBox>
    <SectionBox title={`Authoritative DNS services (${dnsRows.length})`}>
      <Table data={dnsRows} columns={[
        {header:'Service',accessorKey:'name'},
        {header:'Type',accessorKey:'type'},
        {header:'Cluster IP',accessorKey:'clusterIP'},
        {header:'Public endpoint',accessorKey:'external'},
        {header:'DNS ports',accessorKey:'ports'},
      ] as any}/>
    </SectionBox>
    <SectionBox title={`Public exits (${(edges || []).length})`}>
      <Table data={edges || []} columns={[
        {header:'Candidate',accessorFn:(x:any)=>x?.metadata?.name || '-'},
        {header:'Area / Region',accessorFn:(x:any)=>`${x?.spec?.area || '-'} / ${x?.spec?.region || '-'}`},
        {header:'Node',accessorFn:(x:any)=>x?.spec?.nodeName || '-'},
        {header:'Public endpoint',accessorFn:(x:any)=>x?.spec?.endpoint?.value || '-'},
        {header:'Gateway VIP',accessorFn:(x:any)=>x?.spec?.gatewayVIP || '-'},
        {header:'Capacity',accessorFn:(x:any)=>(x?.spec?.capacityMbps ?? null) === null ? '-' : `${x.spec.capacityMbps} Mbps`},
        {header:'State',accessorFn:(x:any)=><StatusLabel status={condition(x,'Ready')?'success':'error'}>{x?.spec?.draining?'Draining':condition(x,'Ready')?'Ready':'Unavailable'}</StatusLabel>},
        {header:'Classes',accessorFn:(x:any)=><Box sx={{display:'flex',gap:.5,flexWrap:'wrap'}}>{(Array.isArray(x?.spec?.serviceClasses) ? x.spec.serviceClasses : []).map((v:string)=><Chip key={v} size="small" label={v}/>)}</Box>},
      ] as any}/>
    </SectionBox>
    <Typography variant="caption" color="text.secondary">发现 {(ingresses || []).length} 个 Ingress、{(routes || []).length} 个 HTTPRoute、{domainRows.length} 个去重域名、{podByIp.size} 个可寻址 Pod。Dry run 表示 ExternalDNS 只预演变更，不会写入权威 DNS；External 表示由集群外系统管理。</Typography>
  </Box>;
}

registerSidebarEntry({name:'public-edge',url:'/public-edge',icon:'mdi:dns',parent:'',label:'DNS & Public Edge'});
registerRoute({path:'/public-edge',sidebar:'public-edge',name:'DNS & Public Edge',component:()=> <Dashboard/>});
