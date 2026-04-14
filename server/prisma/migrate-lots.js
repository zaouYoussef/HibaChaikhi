import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const meds = await prisma.medicament.findMany({
    include: {
      lots: true,
    },
  });

  let created = 0;
  for (const med of meds) {
    if ((med.lots?.length ?? 0) > 0) continue;
    const legacyQty = Number(med.quantite ?? 0);
    if (!legacyQty || legacyQty <= 0 || !med.dateExpiration) continue;

    await prisma.lot.create({
      data: {
        medicamentId: med.id,
        numeroLot: `LEGACY-${med.id.slice(0, 8).toUpperCase()}`,
        quantite: legacyQty,
        dateExpiration: med.dateExpiration,
      },
    });
    created += 1;
  }

  console.log(`Migration lots terminée. Lots créés: ${created}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
