"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { api, errorText, type User } from "@/lib/client";
import { useSession } from "./Session";

/** Shared login / register form. Both routes set the session cookie and return { user }. */
export default function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const { setUser } = useSession();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = mode === "register" ? { name, email, password } : { email, password };
      const { user } = await api<{ user: User }>(`/api/auth/${mode}`, { method: "POST", body });
      setUser(user);
      router.push(user.role === "admin" ? "/admin" : "/");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ maxWidth: 420 }}>
      <h1>{mode === "login" ? "Log in" : "Create an account"}</h1>
      <form className="form card" onSubmit={submit}>
        {mode === "register" && (
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
          </label>
        )}
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={mode === "register" ? 8 : undefined}
            autoComplete={mode === "register" ? "new-password" : "current-password"}
          />
        </label>
        {error && <p className="error" style={{ margin: 0 }}>{error}</p>}
        <button type="submit" disabled={busy}>
          {mode === "login" ? "Log in" : "Register"}
        </button>
      </form>
      <p className="muted small">
        {mode === "login" ? (
          <>
            No account? <Link href="/register">Register as a researcher</Link>
          </>
        ) : (
          <>
            Already registered? <Link href="/login">Log in</Link>
          </>
        )}
      </p>
    </div>
  );
}
