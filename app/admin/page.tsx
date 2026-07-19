import type { Metadata } from "next";
import StaffPortal from "@/app/staff/StaffPortal";

export const metadata: Metadata = { title: "Pizza 62 Admin", robots: { index: false, follow: false } };
export default function AdminPage() { return <StaffPortal mode="admin" />; }
