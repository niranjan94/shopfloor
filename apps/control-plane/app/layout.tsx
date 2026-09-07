import type { ReactNode } from "react";

export const metadata = {
  title: "Shopfloor control plane",
  description: "Self-hosted Shopfloor webhook router on Vercel",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#fafafa", color: "#111" }}>
        {children}
      </body>
    </html>
  );
}
