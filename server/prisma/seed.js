import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const email = process.env.DEMO_USER_EMAIL ?? "hiba.chakhi@caravane.test";
const password = process.env.DEMO_USER_PASSWORD ?? "CaravaneMedicale2026";
const displayName = process.env.DEMO_USER_NAME ?? "Hiba CHAIKHI";

const MEDICAMENTS = [
  { nom: "Doliprane", principeActif: "Paracetamol", dosage: "500 mg" },
  { nom: "Doliprane", principeActif: "Paracetamol", dosage: "1000 mg" },
  { nom: "Efferalgan", principeActif: "Paracetamol", dosage: "500 mg" },
  { nom: "Dafalgan", principeActif: "Paracetamol", dosage: "1000 mg" },
  { nom: "Advil", principeActif: "Ibuprofene", dosage: "200 mg" },
  { nom: "Nurofen", principeActif: "Ibuprofene", dosage: "400 mg" },
  { nom: "Brufen", principeActif: "Ibuprofene", dosage: "600 mg" },
  { nom: "Aspirine UPSA", principeActif: "Acide acetylsalicylique", dosage: "500 mg" },
  { nom: "Kardegic", principeActif: "Acide acetylsalicylique", dosage: "75 mg" },
  { nom: "Spasfon", principeActif: "Phloroglucinol", dosage: "80 mg" },
  { nom: "No Spa", principeActif: "Drotaverine", dosage: "40 mg" },
  { nom: "Smecta", principeActif: "Diosmectite", dosage: "3 g" },
  { nom: "Meteospasmyl", principeActif: "Alverine + Simeticone", dosage: "60 mg/300 mg" },
  { nom: "Imodium", principeActif: "Loperamide", dosage: "2 mg" },
  { nom: "Tiorfan", principeActif: "Racecadotril", dosage: "100 mg" },
  { nom: "Motilium", principeActif: "Domperidone", dosage: "10 mg" },
  { nom: "Vogalene", principeActif: "Metopimazine", dosage: "7.5 mg" },
  { nom: "Gaviscon", principeActif: "Alginate + Bicarbonate", dosage: "500 mg/267 mg" },
  { nom: "Maalox", principeActif: "Aluminium + Magnesium", dosage: "400 mg/400 mg" },
  { nom: "Omeprazole Biogaran", principeActif: "Omeprazole", dosage: "20 mg" },
  { nom: "Inexium", principeActif: "Esomeprazole", dosage: "20 mg" },
  { nom: "Pantoprazole EG", principeActif: "Pantoprazole", dosage: "40 mg" },
  { nom: "Augmentin", principeActif: "Amoxicilline + Acide clavulanique", dosage: "1 g/125 mg" },
  { nom: "Amoxicilline Sandoz", principeActif: "Amoxicilline", dosage: "1 g" },
  { nom: "Clamoxyl", principeActif: "Amoxicilline", dosage: "500 mg" },
  { nom: "Zithromax", principeActif: "Azithromycine", dosage: "500 mg" },
  { nom: "Rovamycine", principeActif: "Spiramycine", dosage: "3 MUI" },
  { nom: "Flagyl", principeActif: "Metronidazole", dosage: "500 mg" },
  { nom: "Bactrim", principeActif: "Sulfamethoxazole + Trimethoprime", dosage: "800 mg/160 mg" },
  { nom: "Ciflox", principeActif: "Ciprofloxacine", dosage: "500 mg" },
  { nom: "Oroken", principeActif: "Cefpodoxime", dosage: "100 mg" },
  { nom: "Rocephine", principeActif: "Ceftriaxone", dosage: "1 g" },
  { nom: "Doxycycline Arrow", principeActif: "Doxycycline", dosage: "100 mg" },
  { nom: "Tavanic", principeActif: "Levofloxacine", dosage: "500 mg" },
  { nom: "Ventoline", principeActif: "Salbutamol", dosage: "100 mcg/dose" },
  { nom: "Bricanyl", principeActif: "Terbutaline", dosage: "0.5 mg/mL" },
  { nom: "Seretide", principeActif: "Salmeterol + Fluticasone", dosage: "50/250 mcg" },
  { nom: "Symbicort", principeActif: "Budesonide + Formoterol", dosage: "200/6 mcg" },
  { nom: "Pulmicort", principeActif: "Budesonide", dosage: "200 mcg/dose" },
  { nom: "Xyzall", principeActif: "Levocetirizine", dosage: "5 mg" },
  { nom: "Aerius", principeActif: "Desloratadine", dosage: "5 mg" },
  { nom: "Zyrtec", principeActif: "Cetirizine", dosage: "10 mg" },
  { nom: "Clarityne", principeActif: "Loratadine", dosage: "10 mg" },
  { nom: "Telfast", principeActif: "Fexofenadine", dosage: "120 mg" },
  { nom: "Atarax", principeActif: "Hydroxyzine", dosage: "25 mg" },
  { nom: "Solupred", principeActif: "Prednisolone", dosage: "20 mg" },
  { nom: "Medrol", principeActif: "Methylprednisolone", dosage: "16 mg" },
  { nom: "Betnesol", principeActif: "Betamethasone", dosage: "0.5 mg" },
  { nom: "Lasilix", principeActif: "Furosemide", dosage: "40 mg" },
  { nom: "Aldactone", principeActif: "Spironolactone", dosage: "25 mg" },
  { nom: "Amlor", principeActif: "Amlodipine", dosage: "5 mg" },
  { nom: "Loxen", principeActif: "Nicardipine", dosage: "50 mg" },
  { nom: "Ramipril Teva", principeActif: "Ramipril", dosage: "5 mg" },
  { nom: "Coversyl", principeActif: "Perindopril", dosage: "5 mg" },
  { nom: "Cozaar", principeActif: "Losartan", dosage: "50 mg" },
  { nom: "Micardis", principeActif: "Telmisartan", dosage: "40 mg" },
  { nom: "Atacand", principeActif: "Candesartan", dosage: "8 mg" },
  { nom: "Atenolol EG", principeActif: "Atenolol", dosage: "50 mg" },
  { nom: "Lopressor", principeActif: "Metoprolol", dosage: "100 mg" },
  { nom: "Corgard", principeActif: "Nadolol", dosage: "40 mg" },
  { nom: "Cordarone", principeActif: "Amiodarone", dosage: "200 mg" },
  { nom: "Tahor", principeActif: "Atorvastatine", dosage: "20 mg" },
  { nom: "Crestor", principeActif: "Rosuvastatine", dosage: "10 mg" },
  { nom: "Zocor", principeActif: "Simvastatine", dosage: "20 mg" },
  { nom: "Plavix", principeActif: "Clopidogrel", dosage: "75 mg" },
  { nom: "Eliquis", principeActif: "Apixaban", dosage: "5 mg" },
  { nom: "Xarelto", principeActif: "Rivaroxaban", dosage: "20 mg" },
  { nom: "Lovenox", principeActif: "Enoxaparine", dosage: "4000 UI" },
  { nom: "Sintrom", principeActif: "Acenocoumarol", dosage: "4 mg" },
  { nom: "Glucophage", principeActif: "Metformine", dosage: "850 mg" },
  { nom: "Diamicron", principeActif: "Gliclazide", dosage: "60 mg" },
  { nom: "Amaryl", principeActif: "Glimepiride", dosage: "2 mg" },
  { nom: "Jardiance", principeActif: "Empagliflozine", dosage: "10 mg" },
  { nom: "Forxiga", principeActif: "Dapagliflozine", dosage: "10 mg" },
  { nom: "Januvia", principeActif: "Sitagliptine", dosage: "100 mg" },
  { nom: "Lantus", principeActif: "Insuline glargine", dosage: "100 UI/mL" },
  { nom: "Humalog", principeActif: "Insuline lispro", dosage: "100 UI/mL" },
  { nom: "Levothyrox", principeActif: "Levothyroxine", dosage: "100 mcg" },
  { nom: "Neomercazole", principeActif: "Carbimazole", dosage: "5 mg" },
  { nom: "Synthol", principeActif: "Hexamidine + Lidocaine", dosage: "spray" },
  { nom: "Hexaspray", principeActif: "Biclotymol", dosage: "spray" },
  { nom: "Eludril", principeActif: "Chlorhexidine + Chlorobutanol", dosage: "0.5 mL/0.5 g" },
  { nom: "Biseptine", principeActif: "Chlorhexidine + Benzalkonium + Alcool benzylique", dosage: "solution" },
  { nom: "Betadine", principeActif: "Povidone iodee", dosage: "10%" },
  { nom: "Dakin Cooper", principeActif: "Hypochlorite de sodium", dosage: "0.5%" },
  { nom: "Fucidine", principeActif: "Acide fusidique", dosage: "2%" },
  { nom: "Bepanthen", principeActif: "Dexpanthenol", dosage: "5%" },
  { nom: "Cicalfate", principeActif: "Sucralfate + Cuivre + Zinc", dosage: "creme" },
  { nom: "Voltarene", principeActif: "Diclofenac", dosage: "50 mg" },
  { nom: "Diclofenac EG", principeActif: "Diclofenac", dosage: "75 mg" },
  { nom: "Celebrex", principeActif: "Celecoxib", dosage: "200 mg" },
  { nom: "Tramadol Biogaran", principeActif: "Tramadol", dosage: "50 mg" },
  { nom: "Ixprim", principeActif: "Tramadol + Paracetamol", dosage: "37.5 mg/325 mg" },
  { nom: "Lamaline", principeActif: "Paracetamol + Opium + Cafeine", dosage: "300 mg/10 mg/30 mg" },
  { nom: "Topalgic", principeActif: "Tramadol", dosage: "100 mg LP" },
  { nom: "Lyrica", principeActif: "Pregabaline", dosage: "75 mg" },
  { nom: "Neurontin", principeActif: "Gabapentine", dosage: "300 mg" },
  { nom: "Rivotril", principeActif: "Clonazepam", dosage: "2 mg" },
  { nom: "Lexomil", principeActif: "Bromazepam", dosage: "6 mg" },
  { nom: "Xanax", principeActif: "Alprazolam", dosage: "0.5 mg" },
  { nom: "Seroplex", principeActif: "Escitalopram", dosage: "10 mg" },
  { nom: "Deroxat", principeActif: "Paroxetine", dosage: "20 mg" },
  { nom: "Prozac", principeActif: "Fluoxetine", dosage: "20 mg" },
  { nom: "Zoloft", principeActif: "Sertraline", dosage: "50 mg" },
  { nom: "Effexor", principeActif: "Venlafaxine", dosage: "75 mg LP" },
  { nom: "Cymbalta", principeActif: "Duloxetine", dosage: "60 mg" },
  { nom: "Abilify", principeActif: "Aripiprazole", dosage: "10 mg" },
  { nom: "Risperdal", principeActif: "Risperidone", dosage: "2 mg" },
  { nom: "Zyprexa", principeActif: "Olanzapine", dosage: "10 mg" },
  { nom: "Seroquel", principeActif: "Quetiapine", dosage: "100 mg" },
  { nom: "Keppra", principeActif: "Levetiracetam", dosage: "500 mg" },
];

function makeBarcode(idx) {
  return `3400${String(1000000 + idx).padStart(7, "0")}`;
}

function pickExpiryDate(index, baseDate) {
  const d = new Date(baseDate);
  // Distribution réaliste:
  // 10% expirés, 15% <7j, 25% <30j, 50% >30j
  if (index < 10) {
    d.setDate(d.getDate() - (1 + (index % 20)));
    return d;
  }
  if (index < 25) {
    d.setDate(d.getDate() + (1 + (index % 6)));
    return d;
  }
  if (index < 50) {
    d.setDate(d.getDate() + (8 + (index % 22)));
    return d;
  }
  d.setDate(d.getDate() + (31 + (index % 240)));
  return d;
}

async function main() {
  const hash = await bcrypt.hash(password, 10);

  await prisma.user.deleteMany({
    where: { email: "etudiant@caravane.test" },
  });

  await prisma.user.upsert({
    where: { email },
    update: { password: hash, name: displayName },
    create: {
      email,
      password: hash,
      name: displayName,
    },
  });

  await prisma.dispenseHistory.deleteMany();
  await prisma.lot.deleteMany();
  await prisma.equivalent.deleteMany();
  await prisma.medicament.deleteMany();

  const today = new Date();
  let i = 0;
  for (const med of MEDICAMENTS.slice(0, 100)) {
    const exp = pickExpiryDate(i, today);
    const qty = 4 + (i % 18);
    const created = await prisma.medicament.create({
      data: {
        nom: med.nom,
        principeActif: med.principeActif,
        dosage: med.dosage,
        codeBarre: makeBarcode(i + 1),
        quantite: qty,
        dateExpiration: exp,
      },
    });
    await prisma.lot.create({
      data: {
        medicamentId: created.id,
        numeroLot: `LOT-${String(i + 1).padStart(3, "0")}-A`,
        quantite: qty,
        dateExpiration: exp,
      },
    });
    i += 1;
  }

  const principleMap = new Map();
  for (const med of MEDICAMENTS.slice(0, 100)) {
    const key = med.principeActif.toLowerCase();
    const arr = principleMap.get(key) ?? [];
    arr.push(med.nom);
    principleMap.set(key, arr);
  }

  for (const [principeActif, names] of principleMap.entries()) {
    const uniq = [...new Set(names)];
    for (const nomMedicament of uniq.slice(0, 3)) {
      await prisma.equivalent.create({
        data: {
          principeActif,
          nomMedicament,
        },
      });
    }
  }

  console.log(`Compte démo créé ou mis à jour :`);
  console.log(`  Nom      : ${displayName}`);
  console.log(`  Email    : ${email}`);
  console.log(`  Mot de passe : ${password}`);
  console.log(`Médicaments seedés : ${Math.min(MEDICAMENTS.length, 100)}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
