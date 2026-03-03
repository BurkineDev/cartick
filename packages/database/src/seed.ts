/**
 * Seed initial data for development/staging
 * Creates: 1 company, cities (OUA, BBO), 1 route, 1 bus, 1 admin user
 */
import { prisma } from "./index.js";
import { SeatType } from "@prisma/client";
import * as crypto from "crypto";

async function main() {
  console.log("🌱 Seeding BuskinaTicket database...");

  // Company
  const company = await prisma.company.upsert({
    where: { slug: "trans-sahel" },
    update: {},
    create: {
      name: "Trans-Sahel Transport",
      slug: "trans-sahel",
      seat_policy: "numbered",
      vip_enabled: true,
      payment_methods: [
        { mode: "orange_money", enabled: true },
        { mode: "moov_money", enabled: true },
        { mode: "wave", enabled: false },
        { mode: "cash", enabled: true },
      ],
      commission_rate: 0.03,
      hold_timeout_minutes: 5,
      timezone: "Africa/Ouagadougou",
      contact_phone: "+22670000000",
    },
  });
  console.log("✅ Company:", company.slug);

  // Cities
  const ouaga = await prisma.city.upsert({
    where: { code: "OUA" },
    update: {},
    create: {
      name: "Ouagadougou",
      code: "OUA",
      latitude: 12.3714,
      longitude: -1.5197,
    },
  });

  const bobo = await prisma.city.upsert({
    where: { code: "BBO" },
    update: {},
    create: {
      name: "Bobo-Dioulasso",
      code: "BBO",
      latitude: 11.1771,
      longitude: -4.2979,
    },
  });
  console.log("✅ Cities: OUA, BBO");

  // Route
  const route = await prisma.route.upsert({
    where: { company_id_code: { company_id: company.id, code: "OUA-BBO" } },
    update: {},
    create: {
      company_id: company.id,
      origin_city_id: ouaga.id,
      destination_city_id: bobo.id,
      code: "OUA-BBO",
      duration_minutes: 300, // 5h
      base_price: 4500, // 4500 XOF
      vip_price: 7500,
    },
  });
  console.log("✅ Route: OUA-BBO");

  // Bus (70 sièges: 65 standard + 5 VIP)
  const seatLayout = generateBusLayout(65, 5);
  const bus = await prisma.bus.upsert({
    where: {
      company_id_registration_number: {
        company_id: company.id,
        registration_number: "11-BF-0001",
      },
    },
    update: {},
    create: {
      company_id: company.id,
      registration_number: "11-BF-0001",
      model: "Yutong ZK6122H9",
      capacity: 70,
      vip_seat_count: 5,
      seat_layout_json: seatLayout,
    },
  });
  console.log("✅ Bus: 11-BF-0001 (70 sièges)");

  // Admin user
  const passwordHash = crypto
    .createHash("sha256")
    .update("Admin@BuskinaTicket2024!")
    .digest("hex");

  const admin = await prisma.user.upsert({
    where: { email: "admin@buskinaticket.bf" },
    update: {},
    create: {
      company_id: company.id,
      email: "admin@buskinaticket.bf",
      phone: "+22670000001",
      phone_hash: crypto
        .createHash("sha256")
        .update("+22670000001")
        .digest("hex"),
      password_hash: passwordHash,
      role: "company_admin",
      first_name: "Admin",
      last_name: "BuskinaTicket",
    },
  });
  console.log("✅ Admin user:", admin.email);

  // Agent user
  const agentHash = crypto
    .createHash("sha256")
    .update("Agent@BuskinaTicket2024!")
    .digest("hex");

  const agent = await prisma.user.upsert({
    where: { email: "agent1@buskinaticket.bf" },
    update: {},
    create: {
      company_id: company.id,
      email: "agent1@buskinaticket.bf",
      phone: "+22670000002",
      phone_hash: crypto
        .createHash("sha256")
        .update("+22670000002")
        .digest("hex"),
      password_hash: agentHash,
      role: "agent",
      first_name: "Seydou",
      last_name: "Kaboré",
    },
  });
  console.log("✅ Agent user:", agent.email);

  // Route and bus info for departure creation
  console.log(
    "\n📋 Seed complete. Route ID:",
    route.id,
    "Bus ID:",
    bus.id
  );
  console.log(
    "   Use POST /company/departures to create departures for this route."
  );
}

/**
 * Génère le layout JSON d'un bus
 * standard_count: nombre de sièges standard
 * vip_count: nombre de sièges VIP (rangée avant)
 */
function generateBusLayout(
  standard_count: number,
  vip_count: number
): object {
  const rows: Array<{
    row: number;
    seats: Array<{ number: string; type: SeatType }>
  }> = [];

  // Rangée VIP (avant)
  if (vip_count > 0) {
    const vipSeats = [];
    for (let i = 1; i <= vip_count; i++) {
      vipSeats.push({ number: `VIP-${i}`, type: "vip" as SeatType });
    }
    rows.push({ row: 0, seats: vipSeats });
  }

  // Rangées standard (4 sièges par rangée: A, B, allée, C, D)
  const totalStandardRows = Math.ceil(standard_count / 4);
  let seatNum = 1;

  for (let r = 1; r <= totalStandardRows; r++) {
    const rowSeats = [];
    const cols = ["A", "B", "C", "D"];
    for (const col of cols) {
      if (seatNum <= standard_count) {
        rowSeats.push({
          number: `${r}${col}`,
          type: "standard" as SeatType,
        });
        seatNum++;
      }
    }
    rows.push({ row: r, seats: rowSeats });
  }

  return {
    rows,
    total_seats: standard_count + vip_count,
    has_aisle_between: ["B", "C"],
  };
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
