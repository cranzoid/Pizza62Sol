# Going live

Everything that has to happen outside the code, in the order it has to happen.
Written to be worked through with the owner in the room.

Nothing here needs a developer except step 1.

---

## Before the call

### 1. Bring the infrastructure up

```bash
cd infra/bootstrap && terraform init && terraform apply   # once per subscription
# copy the printed values into infra/backend.hcl

cd .. && terraform init -backend-config=backend.hcl
terraform workspace new prod
terraform apply
```

About ten minutes, most of it Postgres. Then:

```bash
terraform output app_url                      # where the site is
terraform output -raw owner_setup_secret_command | bash   # the bootstrap secret
```

### 2. Create the owner account

Open `<app_url>/admin`, choose first-time owner setup, and paste the secret from
the command above.

**The secret is spent once used.** It only works while no staff account exists,
so it cannot be replayed later. Give the owner their own email and password at
this point — do not create the account under yours and hand it over, because the
audit log will then record every one of their actions as yours.

If you need a fresh secret (a typo, an abandoned attempt):

```bash
az keyvault secret set --vault-name "$(terraform output -raw key_vault)" \
  --name owner-setup-secret --value "$(openssl rand -base64 36)"
az webapp restart -g "$(terraform output -raw resource_group)" -n "$(terraform output -raw app_name)"
```

---

## On the call with the owner

Everything below is done from **Admin → Integrations**, on any device. Have the
owner sign in to Clover on their laptop at the same time.

### 3. Clover

The owner already has a public and a private token. Only the private one is used
here — the public token is for building your own card form, which this does not.

| What | Where they get it |
|---|---|
| **Merchant ID** | In the address bar of their Clover dashboard, after `/m/`. No support ticket needed |
| **Private API token** | They have it |
| **Webhook signing secret** | Clover dashboard → Settings → Ecommerce → Hosted Checkout → generate |
| **Environment** | Choose **Sandbox** now. Production after the test order works |

Then, in the *same* Clover screen, paste the two URLs the Integrations tab shows
under "Addresses to paste elsewhere":

- **Webhook URL** → `<app_url>/api/payments/clover/webhook`
- **Return URL** → `<app_url>/order/return`

> ⚠️ **The return URL is set once per merchant, not per order.** Every paying
> customer lands on that one path. If it is wrong, payments still work and every
> customer sees an error page.

> ⚠️ **Set the custom domain first if you are going to.** These URLs are baked
> into Clover's dashboard; changing the domain later means coming back here.

The Integrations tab will show **"Customers can pay online — Ready"** once the
merchant ID, token and webhook secret are all in.

### 4. Email

Resend (free, 3,000/month) or SendGrid. Resend is the default.

1. Sign up, create an API key, paste it in.
2. **Verify a sending domain** in the provider's dashboard — add the SPF and DKIM
   records they give you to the restaurant's DNS.
3. Set "Send from" to an address on that domain, e.g. `orders@pizza62.ca`.

> ⚠️ **A gmail.com address cannot be a sender.** Only Google can prove ownership
> of gmail.com, so mail claiming to be from one will be rejected or filed as
> spam. `info.pizza62@gmail.com` is set up as a *recipient* — it receives the
> new-order alerts — which is a different thing entirely.
>
> Until the domain is verified, use the provider's sandbox sender so confirmations
> at least go somewhere.

Press **Test email**. It sends a real one. Check it arrives, and check it is not
in the spam folder — that is what the domain verification is for.

### 5. Twilio

| What | Notes |
|---|---|
| **Account SID / Auth token** | From the Twilio console |
| **Twilio number** | E.164, e.g. `+19055550100`. A local Canadian number is fine — outbound calls need no verification |
| **Number to ring in the kitchen** | E.164. **Not necessarily the number customers call** — this is the one that should ring at 9pm |
| **Times to call back / minutes between** | Defaults 3 and 2. It keeps calling until somebody presses 1 |
| **Text customers too** | **Leave off.** See below |

Press **Test call**. The kitchen phone should ring and read out a test message.

> **Why customer texting is off.** The Twilio number is an unregistered local long
> code, and Canadian carriers filter application-to-person texts from those —
> *silently*. A customer would believe they had been told about their order and
> never have been. Email is the reliable channel. Turn this on only after
> registering the number for A2P messaging.

### 6. Check the settings against the flyer

**Admin → Settings**, and **Admin → Menu setup**. Everything is editable: pizza
prices per size, extra-topping rates, toppings, deals, delivery, hours.

Currently set:

| | |
|---|---|
| HST | 13%, charged on food **and** the delivery fee — matches the owner's prior receipts |
| Delivery | $3.50, 10 km radius, **$20 minimum** before tax |
| Estimates | Pickup 15 min, delivery 30 min |
| Last orders | 20 minutes before closing |
| Restaurant email | `info.pizza62@gmail.com` |

Go through the pizza prices with the owner and the physical flyer in hand.

One thing that looks like an error and is not, so nobody "fixes" it later: the
regular X-Large 3-topping is **$17.69** (base + 2 × extra) while the flyer's
X-Large 3-topping is **$15.99**. Those are two different products — the $15.99 is
a **pickup-only special** — and both are in the menu deliberately. Confirmed by
the owner, 2026-08-21.

The tax rule is confirmed against a real receipt from the previous system:
$30.99 food + $5.00 shipping + $4.68 HST = $40.67, which is 13% of food *plus*
shipping. `tests/domain.test.ts` reproduces it exactly.

### 7. Pair the time-clock tablet

**Admin → Team → Time clock tablet → Generate pairing link.** Open that link once
on the tablet. It stores the token and forgets the URL.

Until this is done the clock-in screen shows no staff list — that is deliberate,
because the list of who works here was previously readable by anyone who found
the URL.

### 8. Set up the printer

The hardware is a **Star TSP143IIILAN** (Ethernet) driving a **Tera 350R** cash
drawer through the printer's DK port.

1. **Find the printer's IP.** Hold the FEED button while switching the printer on.
   It prints a self-test page with its IP address on it.
2. **Give it a DHCP reservation** in the router, so the address does not move.
3. **Install Star PassPRNT** (free, Play Store) on the Samsung tablet.
4. In PassPRNT, add the printer by that IP and switch the **cash drawer** setting
   on.
5. Open the kitchen board in Chrome on the tablet and print a test ticket.

Kitchen tickets print today with no hardware at all through the browser's own
print dialogue, so the restaurant is not blocked on any of this.

---

## Then: the test order

**Still in Clover sandbox.** Place a real order through the website:

1. Build a pizza, add it, open the cart.
2. Go to checkout. Check the breakdown — subtotal, HST, delivery, total. **That
   number comes from the server and is exactly what will be charged.**
3. Tick the terms box, pay with a Clover sandbox test card.
4. You should land back on the site and see the order confirmed within a few
   seconds of the webhook arriving.
5. The kitchen board should show it, the kitchen phone should ring, and a
   confirmation email should arrive.
6. Press 1 on the phone — the "waiting for acknowledgement" banner should clear.
7. Move it through preparing → ready → completed on the kitchen board.

If all of that works, switch **Clover environment → Production** in the
Integrations tab, and place one more order with a real card for a small amount.
Refund it from the Clover dashboard, then record the refund in **Admin → History**
so the two agree.

---

## The custom domain

Do this **before** step 3 if you can, so the Clover URLs never need changing.

1. Set `custom_domain` in `infra/terraform.tfvars` and run `terraform apply`. It
   will fail, and print the two DNS records it needs.
2. Create both at the registrar: a `CNAME` to the App Service hostname, and an
   `asuid.<domain>` `TXT` record.
3. Wait for them to resolve, then apply again. The TLS certificate is free and
   renews itself.
4. Update the Clover webhook and return URLs to the new domain.

---

## Day-to-day, for the owner

| To do this | Go here |
|---|---|
| Stop taking orders for an hour | Settings → Holidays & closures → "For 1 hour" |
| Close for a holiday | Settings → Holidays & closures → pick the dates |
| Close delivery but stay open for pickup | Same screen, "What is closed" → Delivery only |
| Change a price | Menu setup |
| Mark something sold out | Live orders → product availability |
| Take a phone or counter order | Take an order |
| See how the week went | History & offers → set the dates → Export CSV |
| Record a refund | History & offers → find the order → Refund |
| Set up an offer | History & offers → Coupons & offers |

**Closures end by themselves.** That is the difference between them and the pause
toggle, and the reason to use them: nobody has to remember to switch the store
back on.

---

## What is still open, honestly

- **Refunds are recorded here, not issued here.** Clover publishes no refund API
  in the contract we have. The refund is issued in their dashboard and recorded
  in the app so the books and the reporting agree. Every screen says so.
- **Customer SMS is built and switched off**, pending a registered A2P number.
- **The weekly database dump is manual.** See `infra/README.md`. Point-in-time
  restore and blob versioning are automatic; the offsite dump is a five-minute
  job that should be diarised.
- **The delivery-area fallback is approximate.** Azure Maps geocodes the address;
  if Maps cannot answer at all, it falls back to 17 hand-entered postal-district
  centre points. Fine for a 10 km radius, not for edge-of-boundary disputes.
