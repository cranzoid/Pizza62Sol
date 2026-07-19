import type { Metadata } from "next";
import CustomerApp from "./customer/CustomerApp";

export const metadata: Metadata = {
  title: "Pizza 62 | Hamilton Pizza, Pickup & Delivery",
  description:
    "Order Pizza 62 favourites, build your own pizza, or explore pickup and family deals in Hamilton, Ontario.",
};

export default function Home() {
  return <CustomerApp />;
}
