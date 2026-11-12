import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Summa — Open-source affiliate marketing platform",
  description:
    "Summa is an open-source affiliate marketing platform: referral attribution, conversion tracking, commissions and payouts in one system.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
