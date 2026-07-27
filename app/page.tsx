import CustomerApp from "./customer/CustomerApp";

// The home page deliberately has no metadata of its own: the title and
// description come from the owner's website editor through the root layout, and
// a page-level title here would override whatever they wrote there.
export default function Home() {
  return <CustomerApp />;
}
