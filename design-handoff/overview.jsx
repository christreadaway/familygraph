// Family Graph — Home / Overview
// Operator's morning-coffee dashboard. Posture-as-ambient-signal is the through-line.
// Renders the same content under three themes; theme switched by [data-theme] on <html>.

const { useState, useEffect, useMemo } = React;
const D = window.FG_DATA;

// ─── Atoms ─────────────────────────────────────────────────────────
function Pill({ kind, children }) {
  return <span className={`fg-pill ${kind}`}>{children}</span>;
}
function Code({ kind, children }) {
  return <span className={`fg-code ${kind || ""}`}>{children}</span>;
}
function Eyebrow({ children, right }) {
  return (
    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom: 10 }}>
      <span className="fg-eyebrow">{children}</span>
      {right}
    </div>
  );
}
function Sparkline({ series, w = 120, h = 32 }) {
  const max = Math.max(...series), min = Math.min(...series);
  const dx = w / (series.length - 1);
  const norm = (v) => h - 4 - ((v - min) / Math.max(1, max - min)) * (h - 8);
  const line = series.map((v, i) => `${i === 0 ? "M" : "L"}${(i*dx).toFixed(1)},${norm(v).toFixed(1)}`).join(" ");
  const area = `${line} L${w},${h} L0,${h} Z`;
  return (
    <svg className="fg-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width:"100%", height:h }}>
      <path className="area" d={area}/>
      <path className="line" d={line}/>
    </svg>
  );
}

// ─── Status rail (the always-on posture signal) ───────────────────
function StatusRail() {
  return (
    <div className="fg-rail">
      <span className="fg-rail-item">
        <span className="dot" style={{background:"var(--c-loopback)"}}/>
        <span style={{color:"var(--c-loopback)"}}>LOOPBACK</span>
        <span>{D.posture.bind}</span>
      </span>
      <span style={{color:"var(--rule-strong)"}}>│</span>
      <span className="fg-rail-item">
        <span className="dot" style={{background:"var(--c-encrypted)"}}/>
        <span style={{color:"var(--c-encrypted)"}}>ENCRYPTED</span>
        <span>{D.posture.cipher}</span>
        <span className="faint">· keyfile {D.posture.keyfile_mode}</span>
      </span>
      <span style={{color:"var(--rule-strong)"}}>│</span>
      <span className="fg-rail-item">
        <span className="dot" style={{background:"var(--c-pseudonym)"}}/>
        <span style={{color:"var(--c-pseudonym)"}}>AUDIT LIVE</span>
        <span>actor=<span style={{color:"var(--ink)"}}>{D.posture.actor}</span></span>
      </span>
      <span style={{ marginLeft:"auto" }} className="fg-rail-item">
        <span>schema {D.posture.schema || D.institution.schema}</span>
        <span className="faint">· up since {D.institution.boot_at.slice(11,16)}</span>
      </span>
    </div>
  );
}

// ─── Header (institution + ambient mode toggle) ───────────────────
function Header({ pseudo, onPseudo }) {
  return (
    <div style={{ padding:"22px 28px 18px", borderBottom:"0.5px solid var(--rule)", display:"flex", justifyContent:"space-between", alignItems:"flex-end", gap:16 }}>
      <div style={{display:"flex", flexDirection:"column", gap:6, minWidth:0}}>
        <div className="fg-eyebrow">FAMILY GRAPH · LOCAL REGISTRY</div>
        <h1 className="fg-h-display" style={{whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{D.institution.name}</h1>
        <div className="mute mono" style={{fontSize:"var(--t-small)"}}>
          profile=<span style={{color:"var(--ink)"}}>{D.institution.profile}</span>
          <span style={{margin:"0 10px"}}>·</span>
          operator=<span style={{color:"var(--ink)"}}>{D.institution.operator}</span>
        </div>
      </div>
      <div style={{display:"flex", gap:8, alignItems:"center"}}>
        <div className="fg-card" style={{display:"flex", alignItems:"center", gap:0, padding:2, borderRadius:"var(--radius-md)"}}>
          <button className={`fg-btn ${!pseudo?"primary":"ghost"}`} onClick={()=>onPseudo(false)} style={{borderRadius:"var(--radius-sm)"}}>
            <span className="fg-sigil pii"><span className="fg-sigil-dot"/></span>
            PII view
          </button>
          <button className={`fg-btn ${pseudo?"primary":"ghost"}`} onClick={()=>onPseudo(true)} style={{borderRadius:"var(--radius-sm)"}}>
            <span className="fg-sigil pseudo"><span className="fg-sigil-dot"/></span>
            Pseudonym view
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Counter card (4-up) ──────────────────────────────────────────
function Counter({ label, value, delta, series, kind }) {
  return (
    <div className="fg-card" style={{padding:"14px 16px"}}>
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"baseline"}}>
        <span className="fg-eyebrow">{label}</span>
        <span className="mono faint" style={{fontSize:"var(--t-micro)"}}>{delta} · 30d</span>
      </div>
      <div style={{display:"flex", alignItems:"flex-end", justifyContent:"space-between", marginTop:8}}>
        <div className="mono tnum" style={{fontSize:28, fontWeight:500, letterSpacing:"-0.02em", lineHeight:1}}>
          {value.toLocaleString()}
        </div>
        <div style={{flex:"0 0 110px"}}><Sparkline series={series}/></div>
      </div>
      {kind && <div className="mono faint" style={{fontSize:"var(--t-micro)", marginTop:4}}>{kind}</div>}
    </div>
  );
}

// ─── Conflict queue card ─────────────────────────────────────────
function ConflictQueue() {
  return (
    <div className="fg-card">
      <div style={{padding:"14px 16px 8px", display:"flex", justifyContent:"space-between", alignItems:"baseline"}}>
        <div>
          <div className="fg-eyebrow">REVIEW QUEUE</div>
          <h2 className="fg-h2" style={{marginTop:4}}>{D.conflicts_open.length} conflicts open <span className="faint mono" style={{fontSize:"var(--t-small)", fontWeight:400}}>· {D.conflicts_open.filter(c=>c.assignee).length} assigned</span></h2>
        </div>
        <button className="fg-btn primary">Review →</button>
      </div>
      <div>
        {D.conflicts_open.map((c) => (
          <div key={c.code} className="fg-row" style={{gridTemplateColumns:"auto 1fr auto auto", gap:14}}>
            <div style={{display:"flex", flexDirection:"column", gap:2}}>
              <Code kind="person">{c.left}</Code>
              <div className="mono faint" style={{fontSize:"var(--t-micro)", marginLeft:14}}>↕ vs</div>
              <Code kind="person">{c.right}</Code>
            </div>
            <div className="col" style={{gap:3, paddingLeft:8}}>
              <div style={{fontSize:"var(--t-small)"}}>{c.reason}</div>
              <div className="mono faint" style={{fontSize:"var(--t-micro)"}}>
                from <span style={{color:"var(--ink-mute)"}}>{c.file}</span> · {c.age} ago
              </div>
            </div>
            <div>
              {c.assignee
                ? <Pill kind="muted">{c.assignee}</Pill>
                : <span className="mono faint" style={{fontSize:"var(--t-micro)"}}>unassigned</span>}
            </div>
            <div className="row gap-2">
              <button className="fg-btn ghost" title="Merge left">←</button>
              <button className="fg-btn ghost" title="Merge right">→</button>
              <button className="fg-btn ghost" title="Reject">✕</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Imports list ─────────────────────────────────────────────────
function ImportsList({ pseudo }) {
  return (
    <div className="fg-card">
      <div style={{padding:"14px 16px 8px", display:"flex", justifyContent:"space-between", alignItems:"baseline"}}>
        <div>
          <div className="fg-eyebrow">RECENT IMPORTS</div>
          <h2 className="fg-h2" style={{marginTop:4}}>5 runs · 1,059 rows</h2>
        </div>
        <button className="fg-btn">+ Import file</button>
      </div>
      <div>
        {D.imports_recent.map(r => {
          const provClass = r.source === "FACTS" ? "facts" : r.source === "RenWeb" ? "renweb" : r.source.includes("Ministry") ? "mp" : "sheets";
          return (
            <div key={r.code} className="fg-row" style={{gridTemplateColumns:"1fr auto auto auto", gap:14}}>
              <div className="col" style={{gap:2}}>
                <div style={{display:"flex", alignItems:"center", gap:8}}>
                  <span className={`fg-prov ${provClass}`}/>
                  <span className="mono" style={{fontSize:"var(--t-small)"}}>
                    {pseudo ? r.code : r.file}
                  </span>
                  <Pill kind="muted">{r.cat}</Pill>
                </div>
                <div className="mono faint" style={{fontSize:"var(--t-micro)", marginLeft:14}}>
                  {r.source} · {r.ran_at} · by {r.actor}
                </div>
              </div>
              <div className="mono tnum" style={{fontSize:"var(--t-small)", textAlign:"right"}}>
                <div>{r.rows} rows</div>
                <div className="faint" style={{fontSize:"var(--t-micro)"}}>
                  +{r.created} new · {r.attached} attached
                </div>
              </div>
              <div style={{textAlign:"right"}}>
                {r.conflicts > 0
                  ? <Pill kind="pii">{r.conflicts} conflict{r.conflicts>1?"s":""}</Pill>
                  : <Pill kind="loopback">clean</Pill>}
              </div>
              <button className="fg-btn ghost">→</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Audit feed ───────────────────────────────────────────────────
function AuditFeed({ pseudo }) {
  return (
    <div className="fg-card">
      <div style={{padding:"14px 16px 8px"}}>
        <Eyebrow right={<span className="mono faint" style={{fontSize:"var(--t-micro)"}}>last 60 min</span>}>AUDIT · LIVE</Eyebrow>
        <h2 className="fg-h2">7 events</h2>
      </div>
      <div style={{padding:"4px 0 8px"}}>
        {D.audit_recent.map((e, i) => (
          <div key={i} className="fg-row" style={{gridTemplateColumns:"auto auto 1fr", gap:12, padding:"8px 16px", borderBottom:"none"}}>
            <span className="mono faint tnum" style={{fontSize:"var(--t-micro)"}}>{e.t}</span>
            <Pill kind={e.action.includes("export") ? "consented" : e.action.includes("read_pii") ? "pii" : e.action.includes("sanitize") ? "pseudonym" : "muted"}>
              {e.action}
            </Pill>
            <div className="col" style={{gap:1, minWidth:0}}>
              <div className="mono" style={{fontSize:"var(--t-small)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>
                <span style={{color:"var(--ink-mute)"}}>{e.actor} →</span> {e.target}
              </div>
              <div className="faint" style={{fontSize:"var(--t-micro)"}}>{pseudo && e.note.includes("(PII") ? "(redacted in pseudonym view)" : e.note}{e.tier===2 && <span style={{marginLeft:6}}><Pill kind="consented">tier-2</Pill></span>}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Consumers (apps connected to Family Graph) ───────────────────
function Consumers() {
  return (
    <div className="fg-card" style={{padding:"14px 16px"}}>
      <Eyebrow right={<span className="mono faint" style={{fontSize:"var(--t-micro)"}}>{D.posture.consumers.length} connected</span>}>CONSUMERS</Eyebrow>
      <div className="col gap-2" style={{marginTop:6}}>
        {D.posture.consumers.map(c => (
          <div key={c.name} style={{display:"grid", gridTemplateColumns:"auto 1fr auto", gap:10, alignItems:"center"}}>
            <span className="fg-rail-item">
              <span style={{width:6, height:6, borderRadius:"50%", background: c.state==="live"?"var(--c-loopback)":"var(--ink-faint)", display:"inline-block"}}/>
            </span>
            <div className="col" style={{gap:1, minWidth:0}}>
              <div className="mono" style={{fontSize:"var(--t-small)"}}>{c.name}</div>
              <div className="mono faint" style={{fontSize:"var(--t-micro)"}}>
                scopes: {c.scopes.join(" · ")}
              </div>
            </div>
            <span className="mono faint" style={{fontSize:"var(--t-micro)"}}>{c.last_seen}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Posture summary card (the trust elevator pitch) ──────────────
function PostureSummary({ pseudo }) {
  return (
    <div className="fg-card" style={{padding:"16px"}}>
      <Eyebrow>POSTURE</Eyebrow>
      <div className="col gap-3" style={{marginTop:8}}>
        <div className="row gap-3" style={{justifyContent:"space-between"}}>
          <div className="col" style={{gap:2}}>
            <div className="mono" style={{fontSize:"var(--t-small)"}}>Loopback bind</div>
            <div className="mono faint" style={{fontSize:"var(--t-micro)"}}>nothing leaves this machine without consent</div>
          </div>
          <Pill kind="loopback">127.0.0.1</Pill>
        </div>
        <div className="row gap-3" style={{justifyContent:"space-between"}}>
          <div className="col" style={{gap:2}}>
            <div className="mono" style={{fontSize:"var(--t-small)"}}>PII at rest</div>
            <div className="mono faint" style={{fontSize:"var(--t-micro)"}}>per-column AES-256-GCM ciphertext</div>
          </div>
          <Pill kind="encrypted">encrypted</Pill>
        </div>
        <div className="row gap-3" style={{justifyContent:"space-between"}}>
          <div className="col" style={{gap:2}}>
            <div className="mono" style={{fontSize:"var(--t-small)"}}>AI workflows</div>
            <div className="mono faint" style={{fontSize:"var(--t-micro)"}}>see pseudonyms only · no exception</div>
          </div>
          <Pill kind="pseudonym">pseudonyms</Pill>
        </div>
        <div className="row gap-3" style={{justifyContent:"space-between"}}>
          <div className="col" style={{gap:2}}>
            <div className="mono" style={{fontSize:"var(--t-small)"}}>Currently viewing</div>
            <div className="mono faint" style={{fontSize:"var(--t-micro)"}}>{pseudo ? "tokenized identifiers · safe to share" : "real names visible · operator session"}</div>
          </div>
          {pseudo ? <Pill kind="pseudonym">pseudonym</Pill> : <Pill kind="pii">PII</Pill>}
        </div>
      </div>
    </div>
  );
}

// ─── The page ─────────────────────────────────────────────────────
function Overview({ pseudo, onPseudo }) {
  return (
    <div style={{minHeight:"100%", background:"var(--bg)"}}>
      <StatusRail/>
      <Header pseudo={pseudo} onPseudo={onPseudo}/>

      <div style={{padding:"20px 28px", display:"grid", gridTemplateColumns:"1fr 320px", gap:20}}>
        {/* MAIN COLUMN */}
        <div className="col gap-4">
          <div style={{display:"grid", gridTemplateColumns:"repeat(4, 1fr)", gap:12}}>
            <Counter label="Families"  value={D.counters.families.value}  delta={D.counters.families.delta}  series={D.counters.families.series}  kind={pseudo? "f_…" : "active"}/>
            <Counter label="Persons"   value={D.counters.persons.value}   delta={D.counters.persons.delta}   series={D.counters.persons.series}   kind={pseudo? "p_…" : "active"}/>
            <Counter label="Addresses" value={D.counters.addresses.value} delta={D.counters.addresses.delta} series={D.counters.addresses.series} kind={pseudo? "addr_…" : "deduped"}/>
            <Counter label="Conflicts" value={D.counters.conflicts.value} delta={D.counters.conflicts.delta} series={D.counters.conflicts.series} kind="open"/>
          </div>

          <ConflictQueue/>
          <ImportsList pseudo={pseudo}/>
        </div>

        {/* SIDEBAR */}
        <div className="col gap-4">
          <PostureSummary pseudo={pseudo}/>
          <Consumers/>
          <AuditFeed pseudo={pseudo}/>
        </div>
      </div>

      <div style={{padding:"14px 28px 28px", borderTop:"0.5px solid var(--rule)", marginTop:8, display:"flex", justifyContent:"space-between"}}>
        <span className="mono faint" style={{fontSize:"var(--t-micro)"}}>
          family-graph · v1 · ~/.family-graph/ · sqlite (encrypted columns)
        </span>
        <span className="mono faint" style={{fontSize:"var(--t-micro)"}}>
          no telemetry · no analytics · no phone-home
        </span>
      </div>
    </div>
  );
}

window.Overview = Overview;
