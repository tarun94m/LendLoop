"use client";
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { UserButton } from "@clerk/nextjs";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { CATEGORIES } from "@/convex/lib";

const ago = (t: number) => { const d = Math.floor((Date.now() - t) / 86400000); return d <= 0 ? "today" : `${d} day${d > 1 ? "s" : ""} ago`; };
function useAct() {
  const [err, setErr] = useState("");
  const run = async (f: () => Promise<unknown>) => { setErr(""); try { await f(); } catch (e) { setErr((e as Error).message.replace(/.*Uncaught Error: /s, "").split("\n")[0]); } };
  return { err, run };
}

export default function Dashboard() {
  const store = useMutation(api.users.store);
  const setNotify = useMutation(api.users.setNotify);
  const me = useQuery(api.users.me);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState("browse");
  useEffect(() => { store().then(() => setReady(true)); }, [store]);
  if (!ready || !me) return <main className="mut">Loading…</main>;
  const tabs = [["browse", "Browse"], ["mine", "My listings"], ["requests", "My requests"], ["incoming", "Incoming"], ...(me.role === "admin" ? [["admin", "Admin"]] : [])];
  return (
    <main>
      <div className="row between"><h1>LendLoop</h1><div className="row"><span className="mut">{me.name}{me.role === "admin" && " · admin"}</span><label className="mut"><input type="checkbox" checked={me.notifyEmail !== false} onChange={(e) => setNotify({ enabled: e.target.checked })} /> email me</label><UserButton /></div></div>
      <div className="row tabs" style={{ margin: "16px 0" }}>{tabs.map(([k, l]) => <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>)}</div>
      {tab === "browse" && <Browse isAdmin={me.role === "admin"} />}
      {tab === "mine" && <Mine />}
      {tab === "requests" && <Loans kind="requests" />}
      {tab === "incoming" && <Loans kind="incoming" />}
      {tab === "admin" && <Admin />}
    </main>
  );
}

function Browse({ isAdmin }: { isAdmin: boolean }) {
  const [cat, setCat] = useState("");
  const tools = useQuery(api.tools.listAll, { category: cat || undefined });
  const request = useMutation(api.loans.request);
  const remove = useMutation(api.tools.remove);
  const [open, setOpen] = useState<string | null>(null);
  const [dates, setDates] = useState({ s: "", e: "" });
  const { err, run } = useAct();
  const datesOk = !!dates.s && !!dates.e && dates.e >= dates.s;
  const todayStr = new Date().toISOString().slice(0, 10);
  return (<>
    <select value={cat} onChange={(e) => setCat(e.target.value)}><option value="">All categories</option>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
    {err && <p className="err">{err}</p>}
    {tools?.length === 0 && <p className="mut">No tools found.</p>}
    {tools?.map((t) => (
      <div key={t._id} className="card">
        <div className="row between"><b>{t.name}</b><span className="row"><span className="tag">{t.category}</span><span className="tag">{t.available ? "available" : "on loan"}</span>{t.ownerTrusted && <span className="tag">★ trusted lender</span>}</span></div>
        <div className="mut">{t.condition} · {t.description} · by {t.ownerName}</div>
        <div className="row" style={{ marginTop: 8 }}>
          <button onClick={() => setOpen(open === t._id ? null : t._id)}>Request</button>
          {isAdmin && <button className="d" onClick={() => run(() => remove({ toolId: t._id }))}>Remove (admin)</button>}
        </div>
        {open === t._id && <div className="row" style={{ marginTop: 8 }}>
          <input type="date" min={todayStr} value={dates.s} onChange={(e) => setDates({ ...dates, s: e.target.value })} />
          <input type="date" min={dates.s || todayStr} value={dates.e} onChange={(e) => setDates({ ...dates, e: e.target.value })} />
          <button className="p" disabled={!datesOk} onClick={() => run(async () => { await request({ toolId: t._id, startDate: dates.s, endDate: dates.e }); setOpen(null); setDates({ s: "", e: "" }); })}>Send request</button>
        </div>}
      </div>))}
  </>);
}

function Mine() {
  const tools = useQuery(api.tools.mine);
  const create = useMutation(api.tools.create), update = useMutation(api.tools.update), remove = useMutation(api.tools.remove);
  const [f, setF] = useState({ name: "", category: CATEGORIES[0], condition: "good", description: "" });
  const { err, run } = useAct();
  return (<>
    <div className="card row">
      <input placeholder="Tool name" maxLength={80} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
      <input placeholder="Condition" value={f.condition} onChange={(e) => setF({ ...f, condition: e.target.value })} />
      <input placeholder="Short description" maxLength={300} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      <button className="p" disabled={!f.name.trim()} onClick={() => run(async () => { await create(f); setF({ ...f, name: "", description: "" }); })}>List tool</button>
    </div>
    {err && <p className="err">{err}</p>}
    {tools?.length === 0 && <p className="mut">You haven’t listed anything yet.</p>}
    {tools?.map((t) => <div key={t._id} className="card row between"><span><b>{t.name}</b> <span className="tag">{t.category}</span><div className="mut">{t.condition} · {t.description}</div></span>
      <span className="row">
        <button onClick={() => { const description = prompt("Description", t.description); if (description !== null) run(() => update({ toolId: t._id, name: t.name, category: t.category, condition: t.condition, description })); }}>Edit</button>
        <button className="d" onClick={() => run(() => remove({ toolId: t._id }))}>Delete</button></span></div>)}
  </>);
}

type LoanRow = { _id: Id<"loans">; toolName: string; borrowerName?: string; ownerName?: string; startDate: string; endDate: string; status: string; lastAutomation: { kind: string; status: string; at: number } | null };
function LoanCard({ l, owner, admin }: { l: LoanRow; owner?: boolean; admin?: boolean }) {
  const decide = useMutation(api.loans.decide), ret = useMutation(api.loans.markReturned);
  const { err, run } = useAct();
  const a = l.lastAutomation;
  return (<div className="card">
    <div className="row between"><b>{l.toolName}</b><span className="tag">{l.status}</span></div>
    <div className="mut">{l.startDate} → {l.endDate} · {owner || admin ? `borrower: ${l.borrowerName}` : `lender: ${l.ownerName}`}{admin && ` · lender: ${l.ownerName}`}</div>
    {a && <div className="mut" style={{ fontSize: 13 }}>⚙ {a.kind.replace(/_/g, " ")}: {a.status} {ago(a.at)}</div>}
    <div className="row" style={{ marginTop: 6 }}>
      {owner && l.status === "requested" && <><button className="p" onClick={() => run(() => decide({ loanId: l._id, approve: true }))}>Approve</button><button onClick={() => run(() => decide({ loanId: l._id, approve: false }))}>Decline</button></>}
      {(owner || admin) && l.status === "approved" && <button onClick={() => run(() => ret({ loanId: l._id }))}>Mark returned</button>}
    </div>{err && <div className="err">{err}</div>}</div>);
}
function Loans({ kind }: { kind: "requests" | "incoming" }) {
  const rows = useQuery(kind === "requests" ? api.loans.myRequests : api.loans.incoming);
  if (!rows) return <p className="mut">Loading…</p>;
  return rows.length ? <>{rows.map((l) => <LoanCard key={l._id} l={l as LoanRow} owner={kind === "incoming"} />)}</> : <p className="mut">Nothing here yet.</p>;
}
function Admin() {
  const audit = useQuery(api.users.auditLog), loans = useQuery(api.loans.adminAll), users = useQuery(api.users.listLenders), setTrusted = useMutation(api.users.setTrusted);
  return (<>
    <h2>Lenders</h2>
    {users?.map((u) => <div key={u._id} className="card row between"><span>{u.name} <span className="tag">{u.role}</span></span>
      <button onClick={() => setTrusted({ userId: u._id, trusted: !u.trusted })}>{u.trusted ? "Remove Trusted Lender" : "Mark Trusted Lender"}</button></div>)}
    <h2>Audit log</h2>{audit?.map((a) => <div key={a._id} className="mut" style={{ fontSize: 13 }}>{new Date(a._creationTime).toLocaleString()} · {a.actorName} · {a.action} {a.detail ?? ""}</div>)}
    <h2>All loans</h2>{loans?.map((l) => <LoanCard key={l._id} l={l as LoanRow} admin />)}
  </>);
}