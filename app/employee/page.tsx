import type { Metadata } from "next";
import StaffPortal from "@/app/staff/StaffPortal";

export const metadata: Metadata = { title: "Pizza 62 Time Clock", robots: { index: false, follow: false } };
export default function EmployeePage() { return <StaffPortal mode="employee" />; }
