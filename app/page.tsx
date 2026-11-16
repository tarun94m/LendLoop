"use client";
import { useQuery } from "convex/react";
import { Authenticated, Unauthenticated } from "convex/react";
import { SignInButton } from "@clerk/nextjs";
import { api } from "@/convex/_generated/api";
import Dashboard from "./dashboard/Dashboard";

function Public() {
  const tools = useQuery(api.tools.listPublic);
  return (
    <main>
      <h1>LendLoop</h1>
      <p className="mut">Borrow what you need. Lend what you don’t.</p>
      <SignInButton mode="modal"><button className="p">Sign in to lend or borrow</button></SignInButton>
      <h2>Available tools</h2>
      {tools === undefined ? <p className="mut">Loading…</p> : tools.length === 0 ? <p className="mut">Nothing listed yet.</p> :
        tools.map((t) => <div key={t._id} className="card row between"><span>{t.name}</span><span className="tag">{t.category}</span></div>)}
    </main>
  );
}
export default function Home() {
  return (<><Unauthenticated><Public /></Unauthenticated><Authenticated><Dashboard /></Authenticated></>);
}
