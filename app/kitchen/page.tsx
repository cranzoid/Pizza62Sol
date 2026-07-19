import type { Metadata } from "next";
import StaffPortal from "@/app/staff/StaffPortal";

export const metadata: Metadata = { title: "Pizza 62 Kitchen", robots: { index: false, follow: false } };
export default function KitchenPage() { return <StaffPortal mode="kitchen" />; }
