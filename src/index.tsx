import { K8s, registerRoute, registerSidebarEntry } from '@kinvolk/headlamp-plugin/lib';
import { SectionBox, StatusLabel, Table } from '@kinvolk/headlamp-plugin/lib/components/common';
import { makeCustomResourceClass } from '@kinvolk/headlamp-plugin/lib/lib/k8s/crd';
import { Alert, Box, Chip, Tab, Tabs, Typography } from '@mui/material';
import { useState } from 'react';

const PublicEdge = makeCustomResourceClass({apiInfo:[{group:'networking.re8ch.com',version:'v1alpha1'}],kind:'PublicEdge',pluralName:'publicedges',singularName:'publicedge',isNamespaced:false});
const HTTPRoute = K8s.ResourceClasses.HTTPRoute;
const HelmRelease = makeCustomResourceClass({apiInfo:[{group:'helm.toolkit.fluxcd.io',version:'v2'}],kind:'HelmRelease',pluralName:'helmreleases',singularName:'helmrelease',isNamespaced:true});

type ExternalSite = {
  name:string;
  hostnames:string[];
  provider:string;
  delivery:string;
  origin:string;
  dnsMode:string;
  sourceOfTruth:string;
  notes?:string;
};

const dnsZones = [
  {zone:'gzsijie.com', provider:'Alibaba Cloud ESA DNS', mode:'External'},
  {zone:'gzsijie.cn', provider:'Alibaba Cloud DNS'},
  {zone:'mzlumora.com', provider:'Alibaba Cloud ESA DNS', mode:'External'},
  {zone:'andypy.com', provider:'Tencent Cloud DNSPod'},
  {zone:'andy4576.com', provider:'Tencent Cloud DNSPod'},
];

function zoneFor(host:string) {
  return dnsZones.find(({zone})=>host===zone || host.endsWith(`.${zone}`));
}

function combine(values:string[]) {
  const items=[...new Set(values.flatMap(splitNames).filter(x=>x && x!=='-'))];
  return items.join(', ') || '-';
}

function condition(item:any, type:string) {
  const data=item?.jsonData || item;
  return data?.status?.conditions?.find((x:any)=>x.type===type)?.status === 'True';
}

function resourceData(item:any) {
  return item?.jsonData || item || {};
}

function annotation(item:any, key:string) {
  return item?.metadata?.annotations?.[key] || '';
}

function splitNames(value:string) {
  return value.split(',').map(x=>x.trim()).filter(Boolean);
}

function externalSitesFrom(configMap:any):ExternalSite[] {
  const raw=configMap?.data?.['sites.json'];
  if (!raw) return [];
  try {
    const parsed=JSON.parse(raw);
    return Array.isArray(parsed?.sites) ? parsed.sites : [];
  } catch {
    return [];
  }
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
  const [selectedZone, setSelectedZone] = useState('all');
  const [edges, edgeError] = PublicEdge.useList({} as any);
  const [helmReleases] = HelmRelease.useList({} as any);
  const [routes, routeError] = HTTPRoute.useList({} as any);
  const [pods] = K8s.ResourceClasses.Pod.useList({} as any);
  const [slices] = K8s.ResourceClasses.EndpointSlice.useList({} as any);
  const [ingresses, ingressError] = K8s.ResourceClasses.Ingress.useList({} as any);
  const [services, serviceError] = K8s.ResourceClasses.Service.useList({} as any);
  const [catalog, catalogError] = K8s.ResourceClasses.ConfigMap.useGet('public-edge-catalog','kube-system');
  const externalSites=externalSitesFrom(catalog);
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

  const externalRows=externalSites.flatMap(site=>(site.hostnames || []).map(host=>({
    host,
    source:`External site ${site.name}`,
    target:site.origin || '-',
    edge:'-',
    path:site.delivery || 'External',
    backends:site.origin || '-',
    nodes:'-',
    state:'Read only',
    managed:false,
    project:site.name,
    sourceOfTruth:site.sourceOfTruth,
    notes:site.notes || '-',
    provider:site.provider,
  })));
  const discoveredRows=[...ingressRows,...routeRows,...externalRows];
  const ownershipFor=(zone:any)=>{
    if (!zone || zone.mode==='External') return zone?.mode || 'Unmanaged';
    const release:any=(helmReleases || []).map(resourceData).find((item:any)=>(item.spec?.values?.domainFilters || []).includes(zone.zone));
    if (!release) return 'Unmanaged';
    if (release.spec?.suspend) return 'Suspended';
    const dryRun=release.spec?.values?.extraArgs?.['dry-run'];
    const ready=(release.status?.conditions || []).some((item:any)=>item.type==='Ready' && item.status==='True');
    if (!ready) return 'Not ready';
    return dryRun===true || dryRun==='true' ? 'Dry run' : 'Managed';
  };
  const domainRows=[...new Set(discoveredRows.map((row:any)=>row.host))].map(host=>{
    const rows=discoveredRows.filter((row:any)=>row.host===host);
    const zone=zoneFor(host);
    const readOnly=rows.some((row:any)=>row.state==='Read only');
    const publicationEligible=rows.some((row:any)=>row.managed);
    const catalogProvider=combine(rows.map((row:any)=>row.provider || '-'));
    return {
      host,
      zone:zone?.zone || 'Unknown',
      provider:catalogProvider!=='-' ? catalogProvider : zone?.provider || 'Unassigned',
      mode:readOnly ? 'Read only' : publicationEligible ? ownershipFor(zone) : zone?.mode || 'Observed',
      source:combine(rows.map((row:any)=>row.source)),
      target:combine(rows.map((row:any)=>row.target)),
      edge:combine(rows.map((row:any)=>row.edge)),
      path:combine(rows.map((row:any)=>row.path)),
      backends:combine(rows.map((row:any)=>row.backends)),
      nodes:combine(rows.map((row:any)=>row.nodes)),
      projects:combine(rows.map((row:any)=>row.project || '-')),
      sourceOfTruth:combine(rows.map((row:any)=>row.sourceOfTruth || '-')),
      notes:combine(rows.map((row:any)=>row.notes || '-')),
      readOnly,
      declarations:rows.length,
    };
  }).sort((a:any,b:any)=>a.zone.localeCompare(b.zone) || a.host.localeCompare(b.host));
  const visibleDomainRows=selectedZone==='all' ? domainRows : domainRows.filter((row:any)=>row.zone===selectedZone);
  const dnsRows=(services || []).filter((service:any)=>(service.spec?.ports || []).some((port:any)=>port.port===53 && port.protocol==='UDP')).map((service:any)=>({
    name:`${service.metadata?.namespace || 'default'}/${service.metadata?.name}`,
    type:service.spec?.type || 'ClusterIP',
    clusterIP:service.spec?.clusterIP || '-',
    external:annotation(service,'networking.re8ch.com/public-endpoint') || (service.status?.loadBalancer?.ingress || []).map((x:any)=>x.hostname || x.ip).filter(Boolean).join(', ') || service.spec?.externalIPs?.join(', ') || '-',
    ports:(service.spec?.ports || []).filter((port:any)=>port.port===53).map((port:any)=>`${port.port}/${port.protocol}`).join(', '),
  }));

  return <Box sx={{p:2}}>
    <Typography variant="h4">DNS & Public Edge</Typography>
    <Typography color="text.secondary">统一查看域名来源、解析目标、公网出口、Gateway/Ingress、后端 Service 与 UDP/53 DNS 服务。配置写入仍由 GitOps 管理。</Typography>
    {(ingressError || serviceError) && <Alert severity="error">无法读取基础网络资源：{String(ingressError || serviceError)}</Alert>}
    {catalogError && <Alert severity="warning">无法读取外部站点目录：{String(catalogError)}</Alert>}
    {(edgeError || routeError) && <Alert severity="info">PublicEdge 或 Gateway API 尚未启用；现有 Ingress 域名仍会正常汇总。</Alert>}
    <Tabs value={selectedZone} onChange={(_event,value)=>setSelectedZone(value)} variant="scrollable" scrollButtons="auto" sx={{mt:2,borderBottom:1,borderColor:'divider'}}>
      <Tab value="all" label={`All (${domainRows.length})`}/>
      {dnsZones.map(({zone})=><Tab key={zone} value={zone} label={`${zone} (${domainRows.filter((row:any)=>row.zone===zone).length})`}/>)}
    </Tabs>
    <SectionBox title={`Domains (${visibleDomainRows.length}/${domainRows.length})`}>
      <Table data={visibleDomainRows} columns={[
        {header:'Hostname',accessorKey:'host'},
        {header:'Provider',accessorKey:'provider'},
        {header:'DNS ownership',accessorFn:(x:any)=><StatusLabel status={x.mode==='Managed'?'success':x.mode==='Dry run'||x.mode==='Suspended'?'warning':x.mode==='External'||x.mode==='Observed'||x.readOnly?'info':'error'}>{x.mode}</StatusLabel>},
        {header:'Project',accessorKey:'projects'},
        {header:'Declared by',accessorFn:(x:any)=>`${x.source}${x.declarations > 1 ? ` (${x.declarations})` : ''}`},
        {header:'DNS target',accessorKey:'target'},
        {header:'Selected exit',accessorKey:'edge'},
        {header:'Traffic path',accessorKey:'path'},
        {header:'Backend service',accessorKey:'backends'},
        {header:'Pod nodes',accessorKey:'nodes'},
        {header:'Source of truth',accessorKey:'sourceOfTruth'},
        {header:'Notes',accessorKey:'notes'},
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
        {header:'Candidate',accessorFn:(x:any)=>resourceData(x)?.metadata?.name || '-'},
        {header:'Area / Region',accessorFn:(x:any)=>`${resourceData(x)?.spec?.area || '-'} / ${resourceData(x)?.spec?.region || '-'}`},
        {header:'Node',accessorFn:(x:any)=>resourceData(x)?.spec?.nodeName || '-'},
        {header:'Public endpoint',accessorFn:(x:any)=>resourceData(x)?.spec?.endpoint?.value || '-'},
        {header:'Gateway VIP',accessorFn:(x:any)=>resourceData(x)?.spec?.gatewayVIP || '-'},
        {header:'Capacity',accessorFn:(x:any)=>(resourceData(x)?.spec?.capacityMbps ?? null) === null ? '-' : `${resourceData(x).spec.capacityMbps} Mbps`},
        {header:'State',accessorFn:(x:any)=>{
          const data=resourceData(x);
          const hasReady=(data?.status?.conditions || []).some((item:any)=>item.type==='Ready');
          const label=data?.spec?.draining?'Draining':hasReady ? (condition(data,'Ready')?'Ready':'Unavailable') : 'Declared';
          return <StatusLabel status={label==='Ready'?'success':label==='Declared'?'info':'error'}>{label}</StatusLabel>;
        }},
        {header:'Classes',accessorFn:(x:any)=>{const data=resourceData(x); return <Box sx={{display:'flex',gap:.5,flexWrap:'wrap'}}>{(Array.isArray(data?.spec?.serviceClasses) ? data.spec.serviceClasses : []).map((v:string)=><Chip key={v} size="small" label={v}/>)}</Box>;}},
      ] as any}/>
    </SectionBox>
    <Typography variant="caption" color="text.secondary">发现 {(ingresses || []).length} 个 Ingress、{(routes || []).length} 个 HTTPRoute、{domainRows.length} 个去重域名、{externalSites.length} 个外部只读项目、{podByIp.size} 个可寻址 Pod。Dry run 表示 ExternalDNS 只预演变更，不会写入权威 DNS；External 与 Read only 表示由集群外系统管理，本页面不会修改其 DNS、CDN 或存储桶。</Typography>
  </Box>;
}

registerSidebarEntry({name:'public-edge',url:'/public-edge',icon:'mdi:dns',parent:'',label:'DNS & Public Edge'});
registerRoute({path:'/public-edge',sidebar:'public-edge',name:'DNS & Public Edge',component:()=> <Dashboard/>});
