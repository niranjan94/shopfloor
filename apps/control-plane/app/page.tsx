import { getQueueBackend, getStoreAsync } from "../lib/runtime.js";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const store = await getStoreAsync();
  const runs = await store.listRuns(20);
  const queueBackend = getQueueBackend();

  return (
    <main
      style={{
        fontFamily:
          "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        maxWidth: 960,
        margin: "48px auto",
        padding: "0 24px",
        lineHeight: 1.5,
      }}
    >
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>Shopfloor control plane</h1>
      <p style={{ color: "#444", marginTop: 0 }}>
        Vercel-hosted webhook router for the Shopfloor delivery pipeline. Point
        your GitHub App webhook here; stage execution runs via{" "}
        <strong>{queueBackend}</strong> queue
        {queueBackend === "logging"
          ? " (attach Inngest, worker URL, or inline execute)"
          : ""}
        .
      </p>
      <ul>
        <li>
          <code>POST /api/github/webhook</code> — GitHub App events
        </li>
        <li>
          <code>GET /api/health</code> — readiness + config checks
        </li>
        <li>
          <code>GET /api/runs</code> — recent routed runs
        </li>
        <li>
          <code>POST /api/worker/execute</code> — HTTP stage worker
        </li>
        <li>
          <code>/api/inngest</code> — Inngest serve endpoint
        </li>
      </ul>

      <h2 style={{ fontSize: 20, marginTop: 32 }}>Recent runs</h2>
      {runs.length === 0 ? (
        <p style={{ color: "#666" }}>No runs yet. Send a webhook or open an issue.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 14,
            }}
          >
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
                <th style={{ padding: "8px 6px" }}>Run</th>
                <th style={{ padding: "8px 6px" }}>Repo</th>
                <th style={{ padding: "8px 6px" }}>Stage</th>
                <th style={{ padding: "8px 6px" }}>Status</th>
                <th style={{ padding: "8px 6px" }}>Issue</th>
                <th style={{ padding: "8px 6px" }}>When</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} style={{ borderBottom: "1px solid #eee" }}>
                  <td style={{ padding: "8px 6px" }}>
                    <a href={`/api/runs/${encodeURIComponent(r.id)}`}>
                      <code>{r.id.slice(0, 24)}…</code>
                    </a>
                  </td>
                  <td style={{ padding: "8px 6px" }}>
                    {r.owner}/{r.repo}
                  </td>
                  <td style={{ padding: "8px 6px" }}>{r.stage}</td>
                  <td style={{ padding: "8px 6px" }}>{r.status}</td>
                  <td style={{ padding: "8px 6px" }}>
                    {r.issueNumber ?? "—"}
                  </td>
                  <td style={{ padding: "8px 6px", color: "#555" }}>
                    {r.createdAt}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ color: "#666", fontSize: 14, marginTop: 24 }}>
        See <code>docs/shopfloor/self-host-vercel.md</code> for setup.
      </p>
    </main>
  );
}
