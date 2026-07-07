import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Titan Trader",
  description: "A local two-player trading table."
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f0e4" },
    { media: "(prefers-color-scheme: dark)", color: "#0e0d0b" }
  ]
};

// Inlined (not in an external file) so it runs synchronously before first
// paint — this is what prevents a flash of the wrong theme. Reads the
// user's explicit choice from localStorage; falls back to the OS-level
// `prefers-color-scheme` when no explicit choice has been made yet.
const THEME_BOOTSTRAP_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem("titan-trader-theme");
    var theme = stored === "light" || stored === "dark"
      ? stored
      : (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.setAttribute("data-theme", theme);
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "dark");
  }
})();
`;

export default function RootLayout({
  children
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    // suppressHydrationWarning: the theme bootstrap script intentionally sets
    // data-theme on <html> before hydration, so the server/client attribute
    // mismatch is expected and must not be "repaired" by React.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
