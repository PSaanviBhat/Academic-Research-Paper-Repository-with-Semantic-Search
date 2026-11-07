"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { useSession } from "./Session";

export default function NavBar() {
  const { user, loading, setUser } = useSession();
  const router = useRouter();

  async function logout() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    setUser(null);
    router.push("/");
  }

  return (
    <header className="nav">
      <nav className="nav-inner" aria-label="Main">
        <Link href="/" className="brand">
          Paper Repository
        </Link>
        <div className="nav-links">
          <Link href="/">Search</Link>
          <Link href="/stats">Statistics</Link>
          {user && <Link href="/bookmarks">Bookmarks</Link>}
          {user?.role === "admin" && <Link href="/admin">Admin</Link>}
        </div>
        <div className="nav-user">
          {loading ? null : user ? (
            <>
              <span>
                {user.name} <span className="badge">{user.role}</span>
              </span>
              <button className="link" onClick={logout}>
                Log out
              </button>
            </>
          ) : (
            <>
              <Link href="/login">Log in</Link>
              <Link href="/register">Register</Link>
            </>
          )}
        </div>
      </nav>
    </header>
  );
}
