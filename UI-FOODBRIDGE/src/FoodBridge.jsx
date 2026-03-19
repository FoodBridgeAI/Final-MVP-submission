/**
 * FoodBridge Planning Table — v2 (UI/UX Redesign)
 * ================================================
 * Visual redesign only. All business logic, formulas,
 * data structures, and column definitions are unchanged.
 *
 * Preserved v2 changes:
 *   1. SuggestedOrderQty subtracts InboundPOQty
 *   2. ProjectedEndInventory adds InboundPOQty
 *   3. Inbound PO column (qty + ETA) — editable
 *   4. Override modal — reason required on Qty change
 *   5. Truck Fill card in summary bar
 *   6. Shelf-life gate warning icon
 *   7. finalOrderQty initialises to null
 */

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Area, AreaChart
} from "recharts";
import {
  AlertTriangle, TrendingUp, TrendingDown, Minus, X,
  Search, Package, DollarSign, Calendar, ChevronDown,
  ChevronUp, ChevronsUpDown, Info, ShoppingCart, Layers,
  ClipboardList, BarChart2, Filter, Truck, ArrowLeft,
  Download, FileText, CheckCircle
} from "lucide-react";

// ─── CONSTANTS (unchanged) ────────────────────────────────────────────────────
const PLANNING_HORIZON_DAYS   = 30;
const LOW_COVERAGE_THRESHOLD  = 7;
const TRUCK_CAPACITY_PALLETS  = 26;

const HORIZON_OPTIONS = [
  { label: "Next 2 weeks", days: 14 },
  { label: "Next 4 weeks", days: 28 },
  { label: "Next month",   days: 30 },
  { label: "Next 6 weeks", days: 42 },
  { label: "Next quarter", days: 90 },
];

const OVERRIDE_REASONS = [
  "Promotional event",
  "Seasonal adjustment",
  "Supplier constraint",
  "Manual count correction",
  "Menu change incoming",
  "Excess stock reduction",
];

// ─── DEMO SUPPLIER REGISTRY ───────────────────────────────────────────────────
// Placeholder supplier names used in the Finalize screen.
// Items are deterministically assigned to one of these suppliers.
const DEMO_SUPPLIERS = [
  { id: "Supplier1",   name: "Supplier 1",  email: "Supplier_1@mail.com"  },
  { id: "Supplier2",   name: "Supplier 2",     email: "Supplier_2@mail.com"   },
  { id: "Supplier3", name: "Supplier 3",  email: "Supplier_3@mail.com" },
];

/** Deterministically pick a demo supplier for any row based on its item number. */
function getDemoSupplier(row) {
  const n = Math.abs(parseInt(row.itemNumber, 10) || row.itemNumber.split("").reduce((a, c) => a + c.charCodeAt(0), 0));
  return DEMO_SUPPLIERS[n % DEMO_SUPPLIERS.length];
}

// ─── CSV PARSING UTILITIES (unchanged) ───────────────────────────────────────
function parseNumericField(value) {
  const parsed = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseOptionalDays(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized === "N/A") return null;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
      continue;
    }
    if (char === "," && !inQuotes) { cells.push(current); current = ""; continue; }
    current += char;
  }
  cells.push(current);
  return cells;
}

function deriveDemandTrend(growthRate, demandPattern) {
  if (String(demandPattern ?? "").toLowerCase().includes("inactive")) return "flat";
  if (growthRate > 0.05)  return "up";
  if (growthRate < -0.05) return "down";
  return "flat";
}

function deriveMinStockLevel(totalUsage, volumeClass) {
  const c = String(volumeClass ?? "").toUpperCase();
  const factor = c.startsWith("A") ? 0.2 : c.startsWith("B") ? 0.15 : 0.1;
  return Math.max(0, Math.round(totalUsage * factor));
}

function parseInventoryCsv(csvText) {
  const lines = csvText.split(/\r?\n/).map(l => l.trimEnd()).filter(Boolean);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]).map(h => h.trim());
  const seen = new Set();

  return lines.slice(1).map((line, index) => {
    const values = parseCsvLine(line);
    const rec = Object.fromEntries(headers.map((h, i) => [h, (values[i] ?? "").trim()]));

    const totalUsage   = parseNumericField(rec["Total Usage"]);
    const growthRate   = parseNumericField(rec["Growth_Rate"]);
    const volumeClass  = rec["Volume_Class"] || "Unclassified";
    const demandPattern= rec["Demand_Pattern"] || "";
    const itemNumber   = rec["Item Number"] || String(index + 1);

    const rawOrderMin = parseNumericField(rec["Order Minimum"] || rec["Min Order Qty"] || rec["Min Order"] || "");
    const rawMfrShelf = parseOptionalDays(rec["Guaranteed Shelf Life"] || rec["Mfr Shelf Life"] || rec["Manufacturer Shelf Life"] || "");
    const csvCategory = rec["Category"] || rec["Item Category"] || rec["Product Category"] || "";
    const storageArea = rec["Storage Area"] || "";
    const itemName    = rec["Item Name"] || "";
    const { topCategory: itemTopCategory, subCategory: itemSubCategory } = (() => {
      if (csvCategory) {
        // CSV can supply either a top key or a sub key directly
        if (TOP_CATEGORY_MAP[csvCategory])  return { topCategory: csvCategory, subCategory: null };
        if (SUB_CATEGORY_MAP[csvCategory])  return { topCategory: SUB_CATEGORY_MAP[csvCategory].topKey, subCategory: csvCategory };
      }
      return deriveItemCategory(itemName, storageArea);
    })();
    // Legacy flat field kept for drawer backward-compat
    const itemCategory = itemSubCategory;

    return {
      id:           itemNumber,
      itemNumber,
      itemName,
      packSize:     rec["Pack"] || "",
      primarySupplier: volumeClass,
      supplier:     rec["Supplier"] || rec["Vendor"] || rec["Supplier Name"] || "",
      itemCategory,
      itemTopCategory,
      itemSubCategory,
      unitPrice:    parseNumericField(rec["Gross Case Weight"]),
      onHandCount:  parseNumericField(rec["On Hand Count"]),
      minStockLevel:deriveMinStockLevel(totalUsage, volumeClass),
      remainingShelfLifeDays: parseOptionalDays(rec["Remaining Shelf life on existing inventory"]),
      leadTimeWorstCase: rec["Lead Time (Worst-Case)"] || "",
      orderMinimum: rawOrderMin > 0 ? rawOrderMin : null,
      mfrShelfLifeDays: rawMfrShelf,
      tixHi:        rec["TIxHI"] || "1 x 1",
      inboundPoQty: 0,
      inboundPoEta: "",
      predictedUsageBase: totalUsage,
      demandTrend:  deriveDemandTrend(growthRate, demandPattern),
      storageArea,
      volumeClass,
      demandPattern,
      activeMonths: parseNumericField(rec["Active_Months"]),
      peakSeason:   rec["Peak_Season"] || "",
      growthRate,
      volatilityCv: parseNumericField(rec["Volatility_CV"]),
      finalOrderQty:  null,
      overrideReason: "",
    };
  }).filter(row => {
    if (seen.has(row.itemNumber)) return false;
    seen.add(row.itemNumber);
    return true;
  });
}

function normalizeProductName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/^[\s#$]+/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function parseMonthlySuggestionsCsv(csvText) {
  const lines = csvText.split(/\r?\n/).map(l => l.trimEnd()).filter(Boolean);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]).map(h => h.trim());
  return lines.slice(1).map(line => {
    const values = parseCsvLine(line);
    const rec = Object.fromEntries(headers.map((h, i) => [h, (values[i] ?? "").trim()]));
    return {
      product:         rec["Product"] || "",
      unit:            rec["Unit"] || "",
      orderQty:        parseNumericField(rec["Order Qty"]),
      avgMonthlyUsage: parseNumericField(rec["Avg Monthly Usage"]),
      stockOnHand:     parseNumericField(rec["Stock on Hand"]),
      priority:        rec["Priority"] || "",
      seasonalPeak:    String(rec["Seasonal Peak"] || "").toLowerCase() === "true",
    };
  });
}

function generateHistory(baseUsage) {
  return Array.from({ length: 8 }, (_, i) => ({
    week: `W-${8 - i}`,
    usage: Math.max(0, Math.round(baseUsage * (0.75 + Math.random() * 0.5))),
  })).reverse();
}

const MENU_LINKS = {
  "1":  ["Grilled Chicken Platter", "Chicken Caesar Wrap", "Protein Bowl"],
  "2":  ["Classic Smash Burger", "BBQ Burger", "Meatball Sub"],
  "3":  ["Pan-Seared Salmon", "Salmon Poke Bowl"],
  "5":  ["Garden Salad", "Spinach & Artichoke Dip"],
  "7":  ["Pasta Carbonara", "Creamy Mushroom Soup"],
  "11": ["Signature Burger", "Pulled Pork Slider"],
  "17": ["Eggs Benedict", "French Toast", "Omelette Station"],
};

// ─── PROCUREMENT CATEGORY TAXONOMY (two-level) ───────────────────────────────
// Top-level = the 8 standard procurement categories.
// Each top category has sub-categories with keyword lists for auto-classification.
const PROCUREMENT_TAXONOMY = [
  {
    key: "food_bev",
    label: "Food & Beverage / Housing",
    shortLabel: "Food & Bev",
    color: "#15803d",
    bg: "rgba(21,128,61,0.08)",
    border: "rgba(21,128,61,0.25)",
    subs: [
      { key: "proteins",      label: "Proteins & Meat",         keywords: ["chicken","beef","pork","lamb","turkey","veal","duck","bison","venison","steak","burger","patty","sausage","bacon","ham","salami","pepperoni","hot dog","wing","rib","loin","breast","thigh","ground","meatball","bratwurst","chorizo","prosciutto","pastrami","brisket","tenderloin","sirloin","ribeye","flank","pulled pork","short rib","corned beef"] },
      { key: "seafood",       label: "Seafood",                 keywords: ["fish","salmon","tuna","tilapia","cod","shrimp","crab","lobster","scallop","clam","oyster","mahi","halibut","bass","trout","snapper","catfish","flounder","squid","calamari","anchovy","sardine","seafood","prawn","mussel","ahi"] },
      { key: "dairy",         label: "Dairy & Eggs",            keywords: ["milk","cream","cheese","butter","yogurt","egg","whey","cheddar","mozzarella","parmesan","brie","gouda","ricotta","provolone","feta","cottage","half and half","heavy cream","sour cream","ice cream","gelato","custard","ghee"] },
      { key: "produce",       label: "Produce",                 keywords: ["lettuce","spinach","kale","arugula","tomato","onion","garlic","pepper","mushroom","broccoli","cauliflower","carrot","celery","cucumber","zucchini","avocado","lemon","lime","berry","apple","orange","fruit","vegetable","herb","cilantro","parsley","basil","potato","corn","asparagus","artichoke","eggplant","squash","radish","beet","cabbage","leek","scallion","chive","ginger","jalapeño","jalapeno","mango","pineapple","melon","peach","pear","grape","strawberry","blueberry","raspberry","cranberry","romaine","endive","fennel","turnip","microgreen"] },
      { key: "dry_goods",     label: "Dry Goods & Grains",      keywords: ["rice","pasta","flour","bread","roll","noodle","oat","quinoa","barley","wheat","grain","cereal","cracker","chip","tortilla","wrap","pita","bun","bagel","muffin","cake","cookie","pastry","sugar","cornmeal","panko","breadcrumb","couscous","polenta","lentil","bean","chickpea","nut","seed","dried","canned","can","jar","mix","powder"] },
      { key: "sauces",        label: "Sauces & Condiments",     keywords: ["sauce","dressing","ketchup","mustard","mayo","mayonnaise","vinegar","marinade","seasoning","spice","rub","glaze","salsa","relish","pickle","jam","jelly","honey","oil","aioli","pesto","hummus","tahini","sriracha","hot sauce","buffalo","teriyaki","bbq","ranch","gravy","stock","broth","base","concentrate","paste","puree"] },
      { key: "beverages",     label: "Beverages",               keywords: ["juice","water","soda","coffee","tea","lemonade","smoothie","shake","beer","wine","spirit","liquor","cocktail","drink","beverage","espresso","brew","cider","kombucha","sparkling","syrup"] },
      { key: "frozen",        label: "Frozen",                  keywords: ["frozen","freeze","iqf"] },
      { key: "food_supplies", label: "Food Service Supplies",   keywords: ["napkin","foil","wrap","container","tray","lid","straw","utensil","fork","knife","spoon","cup","plate","apron","uniform","packaging","to-go","takeout","to go"] },
    ],
  },
  {
    key: "facilities",
    label: "Facilities & Fleet",
    shortLabel: "Facilities",
    color: "#92400e",
    bg: "rgba(146,64,14,0.07)",
    border: "rgba(146,64,14,0.25)",
    subs: [
      { key: "janitorial",  label: "Janitorial & Cleaning",  keywords: ["cleaning","cleaner","sanitizer","soap","detergent","bleach","chemical","mop","broom","bucket","trash","liner","bag","glove","tissue","paper towel","towel"] },
      { key: "building",    label: "Building & Maintenance", keywords: ["repair","maintenance","paint","caulk","seal","lumber","plumbing","electrical","light bulb","filter","hvac","tool","hardware","screw","nail","bracket","fixture"] },
      { key: "fleet",       label: "Fleet & Automotive",     keywords: ["vehicle","truck","van","fuel","oil","tire","fleet","automotive","brake","battery","wiper","coolant"] },
      { key: "furniture",   label: "Furniture & Fixtures",   keywords: ["chair","table","desk","shelf","cabinet","rack","locker","mat","rug","sign","furniture"] },
    ],
  },
  {
    key: "admin",
    label: "Administrative & Business Ops",
    shortLabel: "Admin",
    color: "#6b7280",
    bg: "rgba(107,114,128,0.08)",
    border: "rgba(107,114,128,0.22)",
    subs: [
      { key: "office_supplies", label: "Office Supplies & Printing", keywords: ["paper","pen","pencil","staple","binder","folder","tape","toner","ink","office","envelope","label","stamp"] },
      { key: "biz_ops",         label: "Business Operations",        keywords: ["form","receipt","invoice","register","till","pos","cash","receipt book"] },
    ],
  },
  {
    key: "it_hardware",
    label: "IT Hardware",
    shortLabel: "IT Hardware",
    color: "#1d4ed8",
    bg: "rgba(29,78,216,0.07)",
    border: "rgba(29,78,216,0.22)",
    subs: [
      { key: "computers",   label: "Computers & Peripherals",      keywords: ["computer","laptop","desktop","monitor","keyboard","mouse","printer","scanner","webcam","headset","tablet","ipad"] },
      { key: "networking",  label: "Networking & Infrastructure",   keywords: ["router","switch","server","rack","ups","modem","wireless","access point","firewall","network","cable"] },
      { key: "av",          label: "Audio/Visual",                  keywords: ["projector","display","speaker","microphone","camera","video","audio","av equipment"] },
    ],
  },
  {
    key: "it_software",
    label: "IT Software",
    shortLabel: "IT Software",
    color: "#7c3aed",
    bg: "rgba(124,58,237,0.07)",
    border: "rgba(124,58,237,0.22)",
    subs: [
      { key: "crm",              label: "CRM",                    keywords: ["crm","salesforce","hubspot","customer relationship"] },
      { key: "data_storage",     label: "Data Storage & Cloud",   keywords: ["storage","cloud","backup","aws","azure","database","hosting","saas"] },
      { key: "research_software",label: "Research & Lab Software",keywords: ["analytics software","research software","lab software","statistical","spss","matlab"] },
    ],
  },
  {
    key: "professional",
    label: "Professional Services",
    shortLabel: "Prof. Services",
    color: "#0e7490",
    bg: "rgba(14,116,144,0.07)",
    border: "rgba(14,116,144,0.22)",
    subs: [
      { key: "consulting", label: "Consulting",      keywords: ["consulting","advisory","management service"] },
      { key: "legal",      label: "Legal & Compliance", keywords: ["legal","attorney","compliance","audit","contract service"] },
      { key: "staffing",   label: "Staffing & HR",   keywords: ["staffing","recruitment","payroll","hr service","training","temp worker"] },
    ],
  },
  {
    key: "scientific",
    label: "Scientific & Research",
    shortLabel: "Scientific",
    color: "#b91c1c",
    bg: "rgba(185,28,28,0.07)",
    border: "rgba(185,28,28,0.22)",
    subs: [
      { key: "lab_equipment",      label: "Lab Equipment & Supplies", keywords: ["lab","laboratory","beaker","pipette","test tube","centrifuge","microscope","reagent","specimen","petri","burette"] },
      { key: "research_materials", label: "Research Materials",        keywords: ["research material","sample kit","specimen","culture","reagent kit","study material"] },
    ],
  },
  {
    key: "travel",
    label: "Travel & Hospitality",
    shortLabel: "Travel",
    color: "#0369a1",
    bg: "rgba(3,105,161,0.07)",
    border: "rgba(3,105,161,0.22)",
    subs: [
      { key: "lodging",       label: "Lodging & Accommodations", keywords: ["hotel","motel","lodging","accommodation","room","linen","amenity","toiletry"] },
      { key: "transportation",label: "Transportation",           keywords: ["flight","airline","rental car","taxi","travel","train","bus ticket"] },
      { key: "events",        label: "Events & Catering",        keywords: ["event","catering","banquet","conference","meeting room","venue","decoration","floral"] },
    ],
  },
];

// Fast lookup maps
const TOP_CATEGORY_MAP = Object.fromEntries(PROCUREMENT_TAXONOMY.map(t => [t.key, t]));
const SUB_CATEGORY_MAP = {};
PROCUREMENT_TAXONOMY.forEach(top =>
  top.subs.forEach(sub => { SUB_CATEGORY_MAP[sub.key] = { ...sub, topKey: top.key }; })
);

// Backward-compat alias used in drawer (flat rule lookup by subCategory key)
const CATEGORY_MAP = SUB_CATEGORY_MAP;

function deriveItemCategory(itemName, storageArea) {
  // Frozen storage area is the most reliable signal
  const area = String(storageArea ?? "").toLowerCase();
  if (area.includes("frozen") || area.includes("freeze")) {
    return { topCategory: "food_bev", subCategory: "frozen" };
  }
  const name = String(itemName ?? "").toLowerCase();
  for (const top of PROCUREMENT_TAXONOMY) {
    for (const sub of top.subs) {
      for (const kw of sub.keywords) {
        if (name.includes(kw)) return { topCategory: top.key, subCategory: sub.key };
      }
    }
  }
  // Default: food service context — most unmatched items are food-related
  return { topCategory: "food_bev", subCategory: "dry_goods" };
}

// ─── CALCULATION UTILITIES (unchanged) ───────────────────────────────────────
function parseTixHi(tixHiStr) {
  const parts = String(tixHiStr).toLowerCase().split("x").map(s => parseInt(s.trim(), 10));
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) return parts[0] * parts[1];
  return 1;
}

function roundUpToPallet(qty, tixHiStr) {
  const pm = parseTixHi(tixHiStr);
  const safe = Math.max(0, Number(qty) || 0);
  if (pm <= 1) return Math.round(safe);
  return Math.ceil(safe / pm) * pm;
}

function scaleUsage(baseUsage, horizonDays) {
  return (baseUsage / PLANNING_HORIZON_DAYS) * horizonDays;
}

// Parse free-text lead time into days. Handles: "3 weeks", "1-2 weeks" (upper bound), "10 days", "2 months".
function parseLeadTimeDays(str) {
  if (!str) return null;
  const s = String(str).toLowerCase().trim();
  const rangeMatch = s.match(/(\d+)\s*[-\u2013]\s*(\d+)\s*(day|week|month)/);
  if (rangeMatch) {
    const upper = parseInt(rangeMatch[2], 10);
    const unit  = rangeMatch[3];
    return unit.startsWith("week") ? upper * 7 : unit.startsWith("month") ? upper * 30 : upper;
  }
  const singleMatch = s.match(/(\d+(?:\.\d+)?)\s*(day|week|month)?/);
  if (singleMatch) {
    const n    = parseFloat(singleMatch[1]);
    const unit = singleMatch[2] || "";
    return unit.startsWith("week") ? Math.round(n * 7) : unit.startsWith("month") ? Math.round(n * 30) : Math.round(n);
  }
  return null;
}

function computeRow(item, horizonDays) {
  const predictedUsage = scaleUsage(item.predictedUsageBase, horizonDays);
  const onHand         = item.onHandCount;
  const minStock       = item.minStockLevel;
  const inboundPo      = Math.max(0, item.inboundPoQty || 0);
  const dailyUsage     = predictedUsage / Math.max(horizonDays, 0.0001);

  // ── 1. Base need ──────────────────────────────────────────────────────────
  const baseNeed = Math.max(0, predictedUsage + minStock - onHand - inboundPo);

  // ── 2. Lead-time buffer ───────────────────────────────────────────────────
  // Add enough stock to cover consumption during the delivery window so we
  // don't deplete existing stock while waiting for the order to arrive.
  const leadTimeDays   = parseLeadTimeDays(item.leadTimeWorstCase);
  const leadTimeBuffer = (leadTimeDays != null && dailyUsage > 1e-6)
    ? Math.max(0, leadTimeDays * dailyUsage - onHand - inboundPo)
    : 0;
  const afterLeadTime  = Math.max(baseNeed, leadTimeBuffer > 0 ? baseNeed + leadTimeDays * dailyUsage - onHand - inboundPo : baseNeed);
  const needWithLT     = Math.max(baseNeed, leadTimeBuffer > 0 ? baseNeed + leadTimeBuffer : baseNeed);

  // ── 3. Round up to pallet ─────────────────────────────────────────────────
  let suggestedOrderQty = roundUpToPallet(needWithLT, item.tixHi);

  // ── 4. Snap up to supplier order minimum ─────────────────────────────────
  const bumpedToMin = item.orderMinimum != null && suggestedOrderQty > 0 && suggestedOrderQty < item.orderMinimum;
  if (bumpedToMin) suggestedOrderQty = item.orderMinimum;

  // ── 5. Cap by manufacturer guaranteed shelf life ──────────────────────────
  // Don't order more than can be consumed before the incoming stock expires.
  let shelfLifeCapped = false;
  if (item.mfrShelfLifeDays != null && dailyUsage > 1e-6 && suggestedOrderQty > 0) {
    const maxConsumable = Math.floor(item.mfrShelfLifeDays * dailyUsage);
    if (suggestedOrderQty > maxConsumable && maxConsumable > 0) {
      suggestedOrderQty = maxConsumable;
      shelfLifeCapped = true;
    }
  }

  // Collect adjustment reasons for UI transparency
  const adjustReasons = [];
  if (leadTimeDays != null && leadTimeBuffer > 0) adjustReasons.push(`+${Math.round(leadTimeBuffer)} cases for ${leadTimeDays}-day lead time buffer`);
  if (bumpedToMin) adjustReasons.push(`Bumped to supplier minimum (${item.orderMinimum?.toLocaleString()} cases)`);
  if (shelfLifeCapped) adjustReasons.push(`Capped at ${suggestedOrderQty} cases by mfr. shelf life (${item.mfrShelfLifeDays}d)`);

  const finalQty = item.finalOrderQty != null ? item.finalOrderQty : suggestedOrderQty;

  const projectedEndingInventory = onHand + inboundPo + finalQty - predictedUsage;

  let coverageDays = null;
  if (predictedUsage > 1e-6 && dailyUsage > 1e-6) {
    const raw = projectedEndingInventory / dailyUsage;
    if (Number.isFinite(raw) && raw >= -1e6 && raw <= 1000) coverageDays = raw;
  }

  let projectedStockoutDate = null;
  if (coverageDays != null && coverageDays < horizonDays) {
    const d = new Date();
    d.setDate(d.getDate() + Math.max(0, Math.floor(coverageDays)));
    projectedStockoutDate = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  const casesPerPallet = parseTixHi(item.tixHi);
  const palletCount    = Math.ceil(finalQty / Math.max(casesPerPallet, 1));

  const shelfLifeGate =
    item.remainingShelfLifeDays != null &&
    item.remainingShelfLifeDays < horizonDays * 0.5 &&
    suggestedOrderQty > 0;

  return {
    predictedUsage:           Math.round(predictedUsage * 10) / 10,
    suggestedOrderQty:        Math.round(suggestedOrderQty * 10) / 10,
    finalOrderQty:            Math.round(finalQty * 10) / 10,
    projectedEndingInventory: Math.round(projectedEndingInventory * 10) / 10,
    coverageDays:             coverageDays == null ? null : Math.round(coverageDays * 10) / 10,
    projectedStockoutDate,
    palletCount,
    shelfLifeGate,
    adjustReasons,
    leadTimeDays,
    bumpedToMin,
    shelfLifeCapped,
  };
}

// ─── STYLES (redesigned — light/neutral professional, IBM Plex) ───────────────
const STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Condensed:wght@400;500;600;700&family=IBM+Plex+Sans:wght@300;400;500;600&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg:          #f2efe9;
    --surface:     #ffffff;
    --surface2:    #f9f7f3;
    --surface3:    #f0ece4;
    --border:      #ddd8cf;
    --border2:     #e8e3da;
    --text:        #1a1714;
    --text2:       #6b6257;
    --text3:       #9e978e;
    --amber:       #a85f08;
    --amber-lt:    #c97c1a;
    --amber-bg:    rgba(168,95,8,0.08);
    --amber-br:    rgba(168,95,8,0.22);
    --green:       #186038;
    --green-bg:    rgba(24,96,56,0.07);
    --green-br:    rgba(24,96,56,0.18);
    --red:         #b83228;
    --red-bg:      rgba(184,50,40,0.07);
    --red-br:      rgba(184,50,40,0.2);
    --blue:        #1a5fa0;
    --blue-bg:     rgba(26,95,160,0.07);
    --ink:         #1c1a17;
    --ink-text:    #e8e3d8;
    --ink-sub:     rgba(232,227,216,0.5);
    --ink-border:  rgba(255,255,255,0.09);
    --gold:        #d4a843;
    /* Column group tints — very subtle alternating bands */
    --g-base:      #ffffff;
    --g-inv:       #fdf9f2;
    --g-ai:        #f4faf7;
    --g-decision:  #fdf8f2;
    --g-impact:    #f6f4fc;
    --radius:      5px;
    --mono:        'IBM Plex Mono', 'Courier New', monospace;
    --ui:          'IBM Plex Sans', sans-serif;
    --head:        'IBM Plex Sans Condensed', sans-serif;
    --shadow-sm:   0 1px 3px rgba(0,0,0,0.07), 0 1px 2px rgba(0,0,0,0.05);
    --shadow-md:   0 4px 16px rgba(0,0,0,0.1), 0 2px 6px rgba(0,0,0,0.06);
    --shadow-lg:   0 12px 40px rgba(0,0,0,0.13), 0 4px 12px rgba(0,0,0,0.06);
  }

  html, body, #root {
    height: 100%; background: var(--bg);
    color: var(--text); font-family: var(--ui);
    overflow-x: hidden;
  }
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: var(--bg); }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--text3); }
  input, select, textarea { font-family: inherit; }

  .app { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }

  /* ── HEADER ── */
  .app-header {
    display: flex; align-items: center; gap: 18px;
    padding: 0 24px; height: 52px;
    background: var(--ink);
    border-bottom: 1px solid var(--ink-border);
    flex-shrink: 0;
  }
  .logo-mark {
    display: flex; align-items: center; gap: 8px;
    font-family: var(--head); font-size: 18px; font-weight: 700;
    letter-spacing: 0.08em; color: var(--gold); text-transform: uppercase;
  }
  .logo-mark span { color: var(--ink-sub); font-weight: 400; }
  .header-sep { width: 1px; height: 24px; background: var(--ink-border); }
  .page-title {
    font-family: var(--head); font-size: 11px; font-weight: 600;
    letter-spacing: 0.16em; text-transform: uppercase; color: var(--ink-sub);
  }
  .header-spacer { flex: 1; }
  .badge {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 4px 10px; border-radius: 4px;
    font-size: 11px; font-family: var(--mono); font-weight: 400;
    background: rgba(212,168,67,0.12); color: var(--gold);
    border: 1px solid rgba(212,168,67,0.22); letter-spacing: 0.03em;
  }

  /* ── FILTERS ── */
  .filters-panel {
    display: flex; align-items: center; gap: 12px;
    padding: 8px 24px; background: var(--surface);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0; flex-wrap: wrap;
  }
  .filter-group { display: flex; align-items: center; gap: 7px; }
  .filter-label {
    font-family: var(--head); font-size: 10px; font-weight: 700;
    letter-spacing: 0.12em; text-transform: uppercase; color: var(--text3);
    white-space: nowrap;
  }
  .search-wrap { position: relative; display: flex; align-items: center; }
  .search-wrap svg { position: absolute; left: 9px; color: var(--text3); pointer-events: none; }
  .search-input {
    background: var(--surface2); border: 1px solid var(--border);
    border-radius: var(--radius); color: var(--text); font-size: 13px;
    padding: 5px 10px 5px 30px; width: 210px; outline: none;
    transition: border-color 0.15s, background 0.15s;
  }
  .search-input:focus { border-color: var(--amber-lt); background: #fff; }
  .search-input::placeholder { color: var(--text3); }
  select.fp-select {
    background: var(--surface2); border: 1px solid var(--border);
    border-radius: var(--radius); color: var(--text); font-size: 12px;
    padding: 5px 28px 5px 10px; outline: none; cursor: pointer; appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239e978e' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 8px center;
    transition: border-color 0.15s; font-family: var(--ui);
  }
  select.fp-select:focus { border-color: var(--amber-lt); }
  .toggle-btn {
    display: flex; align-items: center; gap: 5px; padding: 5px 11px;
    border-radius: var(--radius); border: 1px solid var(--border);
    background: var(--surface2); color: var(--text2);
    font-size: 11px; font-family: var(--head); font-weight: 700;
    letter-spacing: 0.07em; text-transform: uppercase;
    cursor: pointer; transition: all 0.14s; white-space: nowrap;
  }
  .toggle-btn:hover { border-color: var(--amber-lt); color: var(--amber); }
  .toggle-btn.active { background: var(--amber-bg); border-color: var(--amber-br); color: var(--amber); }
  .supplier-pills { display: flex; flex-wrap: wrap; gap: 4px; }
  .pill {
    padding: 3px 9px; border-radius: 20px; border: 1px solid var(--border);
    background: transparent; color: var(--text2); font-size: 11px;
    font-family: var(--mono); cursor: pointer; transition: all 0.14s; white-space: nowrap;
  }
  .pill.active { background: var(--amber-bg); border-color: var(--amber-br); color: var(--amber); }

  /* ── SUMMARY BAR ── */
  .summary-bar {
    display: flex; align-items: stretch;
    background: var(--surface); border-bottom: 2px solid var(--border);
    flex-shrink: 0; overflow-x: auto;
  }
  .stat-card {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 22px; border-right: 1px solid var(--border2);
    min-width: 160px; transition: background 0.14s;
  }
  .stat-card:hover { background: var(--surface2); }
  .stat-icon {
    width: 34px; height: 34px; border-radius: 8px;
    display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  }
  .stat-icon.amber  { background: var(--amber-bg); color: var(--amber); }
  .stat-icon.blue   { background: var(--blue-bg);  color: var(--blue); }
  .stat-icon.red    { background: var(--red-bg);   color: var(--red); }
  .stat-icon.green  { background: var(--green-bg); color: var(--green); }
  .stat-icon.purple { background: rgba(109,40,217,0.07); color: #6d28d9; }
  .stat-value {
    font-family: var(--mono); font-size: 17px; font-weight: 500;
    color: var(--text); line-height: 1;
  }
  .stat-label {
    font-family: var(--head); font-size: 10px; font-weight: 700;
    letter-spacing: 0.11em; text-transform: uppercase;
    color: var(--text3); margin-top: 3px;
  }

  /* ── TRUCK FILL ── */
  .truck-fill-card { min-width: 240px; }
  .truck-fill-wrap { margin-top: 6px; }
  .truck-fill-track { height: 4px; background: var(--border2); border-radius: 2px; overflow: hidden; width: 150px; }
  .truck-fill-fill { height: 100%; border-radius: 2px; transition: width 0.4s ease; }
  .truck-fill-label { font-size: 10px; color: var(--text3); font-family: var(--mono); margin-top: 3px; }

  /* ── TABLE GRID ── */
  .grid-container { flex: 1; overflow: auto; position: relative; background: var(--bg); }
  table.fp-table {
    border-collapse: separate; border-spacing: 0;
    width: max-content; min-width: 100%; table-layout: fixed;
  }

  /* Fluid spacer column — let table visually reach viewport edge */
  table.fp-table thead th.fp-spacer,
  table.fp-table tbody td.fp-spacer {
    background: var(--bg);
    border-right: none;
  }

  /* Sticky header */
  table.fp-table thead th {
    position: sticky; top: 0; z-index: 10; padding: 0;
    border-bottom: 2px solid var(--border); user-select: none;
  }

  /* Group header row */
  table.fp-table thead tr.group-row th {
    padding: 5px 10px 4px;
    font-family: var(--head); font-size: 9px; font-weight: 700;
    letter-spacing: 0.18em; text-transform: uppercase;
    border-bottom: 1px solid var(--border2);
    border-right: 1px solid var(--border2);
    text-align: left;
  }
  /* Column header row */
  table.fp-table thead tr.col-row th {
    padding: 7px 8px 6px 10px;
    font-family: var(--head); font-size: 11px; font-weight: 600;
    letter-spacing: 0.05em; text-transform: uppercase;
    color: var(--text2); white-space: nowrap; text-align: right;
    border-right: 1px solid var(--border2); cursor: pointer;
  }
  table.fp-table thead tr.col-row th:first-child,
  table.fp-table thead tr.col-row th:nth-child(2) { text-align: left; }
  table.fp-table thead tr.col-row th:hover { color: var(--text); }
  .th-inner { display: flex; align-items: center; justify-content: flex-end; gap: 4px; }
  .th-inner.left { justify-content: flex-start; }

  /* Column group text colors */
  .col-group-item   { color: var(--text3)  !important; }
  .col-group-inv    { color: var(--amber)  !important; }
  .col-group-sug    { color: var(--green)  !important; }
  .col-group-plan   { color: var(--amber-lt) !important; }
  .col-group-impact { color: #6d28d9      !important; }

  /* Column group background tints — alternating bands on th and td */
  .g-base     { background: var(--g-base); }
  .g-inv      { background: var(--g-inv); }
  .g-ai       { background: var(--g-ai); }
  .g-decision { background: var(--g-decision); }
  .g-impact   { background: var(--g-impact); }

  /* Body rows */
  table.fp-table tbody tr { transition: filter 0.08s; }
  table.fp-table tbody tr:hover td { filter: brightness(0.965); }

  /* Risk row states — override group tints */
  table.fp-table tbody tr.warn-critical td {
    background: rgba(184,50,40,0.055) !important;
  }
  table.fp-table tbody tr.warn-critical td:first-child {
    border-left: 3px solid var(--red);
  }
  table.fp-table tbody tr.warn-caution td {
    background: rgba(168,95,8,0.044) !important;
  }
  table.fp-table tbody tr.warn-caution td:first-child {
    border-left: 3px solid var(--amber-lt);
  }
  table.fp-table tbody tr.selected td {
    background: rgba(26,95,160,0.055) !important;
  }
  table.fp-table tbody tr.selected td:first-child {
    border-left: 3px solid var(--blue);
  }

  table.fp-table tbody td {
    padding: 6px 10px; font-size: 13px;
    border-bottom: 1px solid var(--border2);
    border-right: 1px solid rgba(221,216,207,0.5);
    white-space: nowrap; text-align: right;
    vertical-align: middle; color: var(--text);
  }
  table.fp-table tbody td:first-child,
  table.fp-table tbody td:nth-child(2) { text-align: left; }

  .cell-mono  { font-family: var(--mono); font-size: 12px; }
  .cell-num   { font-family: var(--mono); font-size: 12px; }
  .cell-muted { color: var(--text3); font-size: 12px; }

  /* ── AI SUGGESTION CHIPS (prominent) ── */
  .sug-qty-chip {
    display: inline-flex; align-items: center; justify-content: center;
    background: var(--green-bg); color: var(--green);
    border: 1px solid var(--green-br);
    border-radius: 4px; padding: 2px 9px;
    font-family: var(--mono); font-size: 12px; font-weight: 500;
    min-width: 46px;
  }
  .proj-end-chip {
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: 4px; padding: 2px 9px;
    font-family: var(--mono); font-size: 12px; font-weight: 500;
    min-width: 46px;
  }
  .proj-end-chip.ok     { background: var(--green-bg);  color: var(--green); border: 1px solid var(--green-br); }
  .proj-end-chip.warn   { background: var(--amber-bg);  color: var(--amber); border: 1px solid var(--amber-br); }
  .proj-end-chip.danger { background: var(--red-bg);    color: var(--red);   border: 1px solid var(--red-br); }

  /* ── EDITABLE CELLS ── */
  .editable-cell input {
    background: var(--surface2); border: 1px solid var(--border); border-radius: 4px;
    color: var(--text); font-family: var(--mono); font-size: 12px;
    padding: 3px 7px; width: 72px; text-align: right; outline: none;
    transition: border-color 0.14s, background 0.14s;
  }
  .editable-cell input:focus { border-color: var(--amber-lt); background: #fff; }
  .editable-cell input.invalid { border-color: var(--red); }
  .editable-cell.final-qty input {
    background: rgba(168,95,8,0.05); border-color: var(--amber-br);
    color: var(--amber); font-weight: 500; width: 72px;
  }
  .editable-cell.final-qty input:focus { background: #fffaf3; border-color: var(--amber); }

  /* ── INBOUND PO CELL ── */
  .inbound-cell { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
  .inbound-cell .inbound-qty input { width: 60px; }
  .inbound-eta-input {
    background: transparent; border: none; border-bottom: 1px solid var(--border2);
    color: var(--text3); font-size: 10px; font-family: var(--mono);
    width: 70px; text-align: right; outline: none; padding: 1px 2px;
    transition: border-color 0.14s;
  }
  .inbound-eta-input:focus { border-color: var(--blue); color: var(--text); }
  .inbound-eta-input::placeholder { color: var(--text3); font-size: 9px; }

  /* ── TREND ICONS ── */
  .trend-up   { color: var(--red);   display: flex; align-items: center; gap: 2px; justify-content: flex-end; }
  .trend-down { color: var(--green); display: flex; align-items: center; gap: 2px; justify-content: flex-end; }
  .trend-flat { color: var(--text3); display: flex; align-items: center; gap: 2px; justify-content: flex-end; }

  /* ── BADGES ── */
  .stockout-badge {
    display: inline-flex; align-items: center; gap: 3px; padding: 2px 7px;
    border-radius: 4px; font-family: var(--mono); font-size: 11px;
    background: var(--red-bg); color: var(--red); border: 1px solid var(--red-br);
  }
  .shelf-gate-icon { color: var(--amber-lt); display: inline-flex; align-items: center; margin-left: 4px; vertical-align: middle; }
  .item-number { font-family: var(--mono); font-size: 11px; color: var(--amber); font-weight: 500; }
  .item-name   { font-size: 13px; color: var(--text); font-weight: 500; overflow: hidden; text-overflow: ellipsis; display: block; }

  /* ── COVERAGE ── */
  .coverage-bar { display: flex; align-items: center; gap: 5px; font-family: var(--mono); font-size: 12px; justify-content: flex-end; }
  .coverage-ok   { color: var(--green); }
  .coverage-warn { color: var(--amber); }
  .coverage-crit { color: var(--red); font-weight: 500; }

  /* ── RESIZE HANDLE ── */
  table.fp-table th { position: relative; }
  .resize-handle { position: absolute; top: 0; right: 0; width: 5px; height: 100%; cursor: col-resize; z-index: 20; }
  .resize-handle::after { content: ''; position: absolute; top: 20%; right: 1px; width: 2px; height: 60%; border-radius: 2px; background: var(--border); transition: background 0.14s; }
  .resize-handle:hover::after { background: var(--amber-lt); }

  /* ── TOOLTIP ── */
  .th-tooltip { position: relative; display: inline-flex; align-items: center; margin-left: 3px; color: var(--text3); cursor: help; flex-shrink: 0; }
  .th-tooltip:hover > svg { color: var(--amber); }
  .th-tooltip:hover .tooltip-popup { opacity: 1; pointer-events: auto; transform: translateX(-50%) translateY(0); }
  .tooltip-popup {
    position: absolute; top: calc(100% + 8px); left: 50%;
    transform: translateX(-50%) translateY(-4px);
    background: var(--surface); border: 1px solid var(--border);
    border-top: 2px solid var(--amber); border-radius: 6px;
    padding: 9px 13px; font-family: var(--ui); font-size: 12px;
    font-weight: 400; line-height: 1.5; color: var(--text);
    text-transform: none; letter-spacing: 0; white-space: normal;
    width: 230px; z-index: 200; opacity: 0; pointer-events: none;
    transition: opacity 0.16s, transform 0.16s;
    box-shadow: var(--shadow-md);
  }
  .tooltip-popup::before { content: ''; position: absolute; top: -6px; left: 50%; transform: translateX(-50%); border-left: 6px solid transparent; border-right: 6px solid transparent; border-bottom: 6px solid var(--amber); }
  .tooltip-popup::after  { content: ''; position: absolute; top: -4px; left: 50%; transform: translateX(-50%); border-left: 5px solid transparent; border-right: 5px solid transparent; border-bottom: 5px solid var(--surface); }

  /* ── DRAWER ── */
  .drawer-overlay { position: fixed; inset: 0; background: rgba(28,26,23,0.3); z-index: 50; backdrop-filter: blur(2px); }
  .drawer {
    position: fixed; top: 0; right: 0; bottom: 0; width: 400px;
    background: var(--surface); border-left: 1px solid var(--border);
    z-index: 51; display: flex; flex-direction: column;
    animation: slideIn 0.22s cubic-bezier(0.25,0.46,0.45,0.94); overflow: hidden;
    box-shadow: var(--shadow-lg);
  }
  @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

  .drawer-header {
    display: flex; align-items: flex-start; justify-content: space-between;
    padding: 18px 20px 14px; flex-shrink: 0;
    background: var(--ink); border-bottom: 1px solid var(--ink-border);
  }
  .drawer-item-num  { font-family: var(--mono); font-size: 10px; color: var(--gold); margin-bottom: 5px; letter-spacing: 0.08em; }
  .drawer-item-name { font-family: var(--head); font-size: 20px; font-weight: 700; color: var(--ink-text); line-height: 1.2; }
  .drawer-sub-row   { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
  .drawer-sub-pill  {
    padding: 2px 8px; border-radius: 3px; font-size: 11px; font-family: var(--mono);
    background: rgba(255,255,255,0.08); color: var(--ink-sub);
    border: 1px solid var(--ink-border);
  }

  .close-btn {
    background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.14);
    border-radius: var(--radius); color: rgba(255,255,255,0.45);
    cursor: pointer; padding: 5px; display: flex; align-items: center;
    transition: all 0.14s; flex-shrink: 0;
  }
  .close-btn:hover { background: rgba(255,255,255,0.14); color: #fff; border-color: rgba(255,255,255,0.3); }

  /* Light-bg close button (modal) */
  .modal .close-btn {
    background: none; border: 1px solid var(--border);
    color: var(--text2);
  }
  .modal .close-btn:hover { border-color: var(--red); color: var(--red); background: none; }

  .drawer-body { flex: 1; overflow-y: auto; padding: 18px 20px; display: flex; flex-direction: column; gap: 20px; }
  .drawer-section-title {
    font-family: var(--head); font-size: 10px; font-weight: 700;
    letter-spacing: 0.16em; text-transform: uppercase; color: var(--text3);
    margin-bottom: 9px; display: flex; align-items: center; gap: 7px;
  }
  .drawer-section-title::after { content: ''; flex: 1; height: 1px; background: var(--border2); }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
  .info-grid-horizontal { grid-template-columns: none; grid-auto-flow: column; grid-auto-columns: minmax(140px,140px); width: max-content; }
  .drawer-item-info-scroll { width: 100%; overflow-x: auto; overflow-y: hidden; padding-bottom: 4px; }
  .info-cell { background: var(--surface2); border: 1px solid var(--border2); border-radius: var(--radius); padding: 8px 10px; }
  .info-cell-label { font-family: var(--head); font-size: 9px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--text3); margin-bottom: 4px; }
  .info-cell-value { font-family: var(--mono); font-size: 13px; color: var(--text); }
  .chart-wrap { height: 130px; background: var(--surface2); border: 1px solid var(--border2); border-radius: var(--radius); padding: 10px; }
  .menu-list { display: flex; flex-direction: column; gap: 4px; }
  .menu-item { display: flex; align-items: center; gap: 8px; padding: 7px 11px; background: var(--surface2); border: 1px solid var(--border2); border-radius: var(--radius); font-size: 13px; color: var(--text2); }
  .menu-item svg { color: var(--amber); flex-shrink: 0; }
  .notes-area {
    background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius);
    color: var(--text); font-family: var(--ui); font-size: 13px; padding: 10px;
    resize: vertical; min-height: 80px; width: 100%; outline: none; transition: border-color 0.14s;
  }
  .notes-area:focus { border-color: var(--amber-lt); background: #fff; }
  .notes-area::placeholder { color: var(--text3); }

  /* ── OVERRIDE MODAL ── */
  .modal-overlay {
    position: fixed; inset: 0; background: rgba(28,26,23,0.45); z-index: 100;
    display: flex; align-items: center; justify-content: center;
    backdrop-filter: blur(3px); animation: fadein 0.15s;
  }
  @keyframes fadein { from { opacity: 0; } to { opacity: 1; } }
  .modal {
    background: var(--surface); border: 1px solid var(--border);
    border-top: 3px solid var(--amber); border-radius: 8px;
    width: 420px; max-width: 90vw;
    box-shadow: var(--shadow-lg); animation: popIn 0.18s ease;
    display: flex; flex-direction: column;
  }
  @keyframes popIn { from { transform: scale(0.96); opacity: 0; } to { transform: scale(1); opacity: 1; } }
  .modal-header { display: flex; align-items: center; gap: 10px; padding: 16px 20px 12px; border-bottom: 1px solid var(--border2); }
  .modal-header-title { flex: 1; font-family: var(--head); font-size: 15px; font-weight: 700; letter-spacing: 0.04em; color: var(--text); }
  .modal-qty-change { display: flex; align-items: center; gap: 8px; margin: 16px 20px 0; padding: 12px 14px; background: var(--surface2); border: 1px solid var(--border2); border-radius: var(--radius); font-family: var(--mono); font-size: 13px; }
  .modal-qty-from  { color: var(--text2); }
  .modal-qty-arrow { color: var(--text3); }
  .modal-qty-to    { color: var(--amber); font-weight: 600; }
  .modal-prompt { padding: 14px 20px 6px; font-size: 13px; color: var(--text2); }
  .reason-list { padding: 0 20px 4px; display: flex; flex-direction: column; gap: 4px; }
  .reason-option {
    display: flex; align-items: center; gap: 10px; padding: 9px 12px;
    border: 1px solid var(--border2); border-radius: var(--radius);
    cursor: pointer; font-size: 13px; color: var(--text2);
    transition: all 0.12s; user-select: none;
  }
  .reason-option:hover { border-color: var(--border); color: var(--text); background: var(--surface2); }
  .reason-option.selected { border-color: var(--amber-br); background: var(--amber-bg); color: var(--amber); }
  .reason-option input[type=radio] { accent-color: var(--amber); cursor: pointer; }
  .modal-footer { display: flex; justify-content: flex-end; gap: 8px; padding: 16px 20px; border-top: 1px solid var(--border2); margin-top: 8px; }
  .btn-ghost { background: none; border: 1px solid var(--border); border-radius: var(--radius); color: var(--text2); font-size: 13px; padding: 7px 16px; cursor: pointer; font-family: var(--ui); transition: all 0.14s; }
  .btn-ghost:hover { border-color: var(--text2); color: var(--text); }
  .btn-confirm { background: var(--amber-bg); border: 1px solid var(--amber-br); border-radius: var(--radius); color: var(--amber); font-size: 13px; font-weight: 600; padding: 7px 18px; cursor: pointer; font-family: var(--ui); transition: all 0.14s; }
  .btn-confirm:disabled { opacity: 0.35; cursor: not-allowed; }
  .btn-confirm:not(:disabled):hover { background: rgba(168,95,8,0.14); }

  /* ── OVERRIDE SELECT ── */
  .override-select {
    background: var(--surface2); border: 1px solid var(--amber-br); border-radius: 4px;
    color: var(--amber); font-size: 11px; padding: 2px 20px 2px 6px; outline: none;
    cursor: pointer; appearance: none; font-family: var(--ui); max-width: 160px;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23a85f08' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 5px center;
  }

  /* ── EMPTY / ERROR ── */
  .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 80px 20px; color: var(--text3); }
  .empty-state svg { opacity: 0.2; }
  .empty-title { font-family: var(--head); font-size: 18px; font-weight: 600; color: var(--text2); }
  .empty-sub { font-size: 13px; }

  .sort-icon { opacity: 0.3; }
  .sort-icon.active { opacity: 1; color: var(--amber); }

  /* ── FAB — Floating Action Button ── */
  .fab {
    position: fixed; bottom: 28px; right: 28px; z-index: 40;
    display: flex; align-items: center; gap: 9px;
    padding: 13px 22px; border-radius: 40px;
    background: var(--ink); color: var(--gold);
    border: 1px solid rgba(212,168,67,0.3);
    font-family: var(--head); font-size: 13px; font-weight: 700;
    letter-spacing: 0.1em; text-transform: uppercase;
    cursor: pointer; box-shadow: 0 4px 22px rgba(0,0,0,0.2), 0 1px 4px rgba(0,0,0,0.1);
    transition: transform 0.18s ease, box-shadow 0.18s ease, background 0.18s;
  }
  .fab:hover {
    background: #2c2a25;
    box-shadow: 0 8px 32px rgba(0,0,0,0.24), 0 2px 8px rgba(0,0,0,0.1);
    transform: translateY(-2px);
    color: #e8c060;
    border-color: rgba(232,192,96,0.4);
  }
  .fab:active { transform: translateY(0); box-shadow: 0 2px 10px rgba(0,0,0,0.18); }

  /* ── FINALIZE VIEW ── */
  .finalize-header {
    display: flex; align-items: center; gap: 18px;
    padding: 0 24px; height: 52px;
    background: var(--ink); border-bottom: 1px solid var(--ink-border);
    flex-shrink: 0;
  }
  .finalize-title {
    font-family: var(--head); font-size: 13px; font-weight: 600;
    letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-text);
  }
  .finalize-toolbar {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 24px; background: var(--surface);
    border-bottom: 2px solid var(--border); flex-shrink: 0; flex-wrap: wrap;
  }
  .finalize-stats-strip { display: flex; align-items: center; gap: 0; flex: 1; }
  .finalize-stat {
    display: flex; flex-direction: column; padding: 0 20px;
    border-right: 1px solid var(--border2);
  }
  .finalize-stat:first-child { padding-left: 0; }
  .finalize-stat-val { font-family: var(--mono); font-size: 16px; font-weight: 500; color: var(--text); line-height: 1; }
  .finalize-stat-label { font-family: var(--head); font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text3); margin-top: 3px; }
  .finalize-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }

  .btn-back {
    display: flex; align-items: center; gap: 6px;
    padding: 7px 13px; border-radius: var(--radius);
    border: 1px solid var(--border); background: transparent; color: var(--text2);
    font-size: 11px; font-family: var(--head); font-weight: 700;
    letter-spacing: 0.07em; text-transform: uppercase; cursor: pointer; transition: all 0.14s;
  }
  .btn-back:hover { border-color: var(--text2); color: var(--text); background: var(--surface2); }

  .btn-export {
    display: flex; align-items: center; gap: 6px;
    padding: 7px 13px; border-radius: var(--radius);
    border: 1px solid var(--border); background: var(--surface2); color: var(--text2);
    font-size: 11px; font-family: var(--head); font-weight: 700;
    letter-spacing: 0.07em; text-transform: uppercase; cursor: pointer; transition: all 0.14s;
  }
  .btn-export:hover { border-color: var(--blue); color: var(--blue); background: var(--blue-bg); }

  .btn-submit {
    display: flex; align-items: center; gap: 7px;
    padding: 8px 20px; border-radius: var(--radius);
    background: var(--ink); color: var(--gold);
    border: 1px solid rgba(212,168,67,0.28);
    font-family: var(--head); font-size: 12px; font-weight: 700;
    letter-spacing: 0.1em; text-transform: uppercase;
    cursor: pointer; transition: all 0.14s;
    box-shadow: 0 2px 6px rgba(0,0,0,0.1);
  }
  .btn-submit:hover { background: #2c2a25; }

  .finalize-grid { flex: 1; overflow: auto; background: var(--bg); }

  table.fin-table {
    border-collapse: separate; border-spacing: 0;
    width: max-content; min-width: 100%; table-layout: fixed;
  }

  /* Step 1 (review) table should always fill viewport width */
  table.fin-table.fin-fill {
    width: 100% !important;
    min-width: 100% !important;
  }
  table.fin-table thead th {
    position: sticky; top: 0; z-index: 10;
    padding: 8px 12px 7px; background: var(--surface);
    border-bottom: 2px solid var(--border);
    font-family: var(--head); font-size: 11px; font-weight: 700;
    letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--text2); white-space: nowrap; text-align: right;
    border-right: 1px solid var(--border2); user-select: none;
  }
  table.fin-table thead th:first-child,
  table.fin-table thead th:nth-child(2) { text-align: left; }
  table.fin-table thead th.fin-key {
    color: var(--amber); background: rgba(168,95,8,0.05);
    border-bottom-color: var(--amber-lt);
  }
  table.fin-table tbody tr { background: var(--surface); transition: background 0.08s; }
  table.fin-table tbody tr:nth-child(even) { background: var(--surface2); }
  table.fin-table tbody tr:hover { background: rgba(26,95,160,0.04); }
  table.fin-table tbody tr.fin-override td:first-child { border-left: 3px solid var(--amber-lt); }
  table.fin-table tbody td {
    padding: 7px 12px; font-size: 13px;
    border-bottom: 1px solid var(--border2);
    border-right: 1px solid rgba(221,216,207,0.4);
    white-space: nowrap; text-align: right; color: var(--text);
    vertical-align: middle;
  }
  table.fin-table tbody td:first-child,
  table.fin-table tbody td:nth-child(2) { text-align: left; }
  table.fin-table tbody td.fin-key {
    background: rgba(168,95,8,0.04);
  }
  table.fin-table tbody td.fin-key .editable-cell input {
    background: rgba(168,95,8,0.06); border-color: var(--amber-br);
    color: var(--amber); font-weight: 600; font-size: 13px; width: 80px;
  }
  table.fin-table tbody td.fin-key .editable-cell input:focus {
    background: #fffaf3; border-color: var(--amber);
  }

  /* Spacer columns (Finalize Step 1) — force table to visually fill wide screens */
  table.fin-table thead th.fin-spacer,
  table.fin-table tbody td.fin-spacer {
    background: var(--bg);
    border-right: none;
  }

  /* ── SUPPLIER FACTOR CARDS ── */
  .supplier-factor-card {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 10px 12px; border-radius: var(--radius);
    border: 1px solid var(--border2);
  }
  .supplier-factor-card.factor-warn {
    background: var(--amber-bg); border-color: var(--amber-br);
  }
  .supplier-factor-card.factor-warn .factor-icon { color: var(--amber); margin-top: 1px; }
  .supplier-factor-card.factor-ok {
    background: var(--green-bg); border-color: var(--green-br);
  }
  .supplier-factor-card.factor-ok .factor-icon { color: var(--green); margin-top: 1px; }
  .factor-label {
    font-family: var(--head); font-size: 9px; font-weight: 700;
    letter-spacing: 0.14em; text-transform: uppercase;
    color: var(--text3); margin-bottom: 3px;
  }
  .factor-value {
    font-family: var(--mono); font-size: 13px; font-weight: 500; color: var(--text);
  }
  .factor-note {
    font-size: 11px; color: var(--text2); margin-top: 4px; line-height: 1.45;
  }

  /* ── SUBMIT SUCCESS ── */
  .submit-success {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    height: 100vh; background: var(--bg); gap: 18px; padding: 40px;
    animation: fadein 0.35s ease;
  }
  .submit-success-icon { color: var(--green); }
  .submit-success-title {
    font-family: var(--head); font-size: 30px; font-weight: 700;
    color: var(--text); letter-spacing: -0.01em;
  }
  .submit-success-sub { font-size: 14px; color: var(--text2); font-family: var(--mono); }

  /* ── PRINT ── */
  @media print {
    .app-header, .filters-panel, .summary-bar, .fab,
    .finalize-header, .finalize-toolbar,
    .drawer, .drawer-overlay, .modal-overlay { display: none !important; }
    .finalize-grid { overflow: visible !important; height: auto !important; }
    html, body, #root { height: auto !important; background: #fff !important; overflow: visible !important; }
    table.fin-table { width: 100% !important; }
    table.fin-table thead th { background: #f0ece4 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    table.fin-table thead th.fin-key { background: #fef0d3 !important; color: #92400e !important; }
    table.fin-table tbody td.fin-key { background: #fffbf0 !important; }
    table.fin-table tbody tr.fin-override td:first-child { border-left: 3px solid #b45309 !important; }
    table.fin-table tbody tr:nth-child(even) { background: #f9f7f3 !important; }
  }
`;

// ─── COLUMN TOOLTIP DESCRIPTIONS (unchanged) ──────────────────────────────────
const COL_TIPS = {
  itemNumber:               "Unique SKU identifier for this item. Used for ordering and tracking across all systems.",
  itemName:                 "Full product name. Click any row to open the detail panel — usage history, menu links, order summary, and planner notes.",
  packSize:                 "How this item is packaged (e.g. '6/10 lb'). All order quantities and prices are in these units.",
  primarySupplier:          "Volume Class (A/B/C) from the CSV. Controls the Min Stock safety buffer — A items carry a 20% cushion, B is 15%, C is 10% of predicted usage.",
  unitPrice:                "Cost per case, proxied from the Gross Case Weight field. Used only to calculate Est. Spend — not a live price feed.",
  onHandCount:              "Physical cases in the warehouse right now. Edit this to correct a mis-count before the order is calculated — it flows directly into the suggestion.",
  minStockLevel:            "The safety floor. The system always orders enough to stay above this at period end. Derived from Volume Class × Predicted Usage, but editable if you know better.",
  remainingShelfLifeDays:   "Days until existing stock expires. Red = ≤7 days, Amber = ≤14 days. A ⚠ icon appears when stock will expire before the horizon midpoint AND an order is suggested — verify before adding more.",
  leadTimeWorstCase:        "Worst-case estimated time for this item to arrive after ordering, estimated from its category and item name.",
  tixHi:                    "Tier × High — the pallet configuration for this item. Order quantities are automatically rounded up to the nearest full pallet multiple using this value.",
  inboundPoQty:             "Cases already ordered and in transit — open POs not yet received. Enter this to prevent the system from suggesting stock that's already on its way. Also accepts a free-text ETA date below.",
  predictedUsage:           "Forecasted cases consumed over the selected horizon, scaled linearly from 30-day historical usage. Change the Horizon dropdown and this updates instantly.",
  demandTrend:              "Growth direction vs. the previous period — up, down, or flat. Informational only. It does not auto-adjust the order formula, but it's a signal to override if demand is clearly shifting.",
  suggestedOrderQty:        "The system's recommendation: max(0, Predicted Usage + Min Stock − On Hand − Inbound PO), rounded up to a full pallet multiple. This is the number you're deciding whether to accept or change.",
  monthlySuggestedPallets:  "The suggested order quantity converted to pallets (Sug. Qty ÷ TI×HI, rounded up). Shows the logistics footprint before you commit.",
  projectedEndingInventory: "Sanity check: On Hand + Inbound PO + Final Qty − Predicted Usage. What you'll have left at period end. Red = stockout, Amber = below Min Stock.",
  finalOrderQty:            "Your confirmed order quantity. Leave blank to accept the system suggestion. Typing a different number triggers an override modal — a reason is required before the change is saved.",
  overrideReason:           "Why you changed the suggested quantity. Captured via the override modal and stored here for the audit trail. Editable after the fact if you need to revise it.",
  coverageDays:             "How many days your projected ending inventory lasts at the forecasted daily usage rate. Red < 7 days (critical), Amber < 14 days (caution). The whole row highlights so critical items are visible at a glance.",
  projectedStockoutDate:    "The actual calendar date you'd run out of stock if your order goes through as planned. Only appears when coverage falls within the planning horizon — a concrete urgency signal.",
  palletCount:              "Final order quantity converted to pallets using TI×HI. This is what rolls up into the Truck Fill bar in the summary — use it to bump or trim line items to hit a full load.",
  estSpend:                 "Final Qty × Unit Price for this line item. Summed across all visible rows to produce the Planned Spend total in the summary bar above.",
};

// ─── COMPONENTS ───────────────────────────────────────────────────────────────

// ColTooltip — unchanged
function ColTooltip({ colKey, text }) {
  const tip = text || COL_TIPS[colKey] || "";
  if (!tip) return null;
  return (
    <span className="th-tooltip">
      <Info size={10}/>
      <div className="tooltip-popup">{tip}</div>
    </span>
  );
}

// EditableCell — unchanged
function EditableCell({ value, onChange, className = "" }) {
  const [local, setLocal] = useState(String(value ?? ""));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setLocal(String(value ?? "")); }, [value]);

  function handleChange(e) {
    const v = e.target.value;
    setLocal(v);
    const n = parseFloat(v);
    if (v === "" || (!isNaN(n) && n >= 0)) {
      setInvalid(false);
      onChange(v === "" ? null : n);
    } else {
      setInvalid(true);
    }
  }

  return (
    <div className={`editable-cell ${className}`}>
      <input type="number" min="0" value={local} onChange={handleChange} className={invalid ? "invalid" : ""}/>
    </div>
  );
}

// FinalQtyCell — unchanged
function FinalQtyCell({ rowId, value, suggestedQty, onRequestOverride, onAccept }) {
  const [local, setLocal] = useState(value != null ? String(value) : "");
  useEffect(() => { setLocal(value != null ? String(value) : ""); }, [value]);

  function commit() {
    if (local.trim() === "") { onAccept(rowId, null); return; }
    const n = parseFloat(local);
    if (isNaN(n) || n < 0) { setLocal(value != null ? String(value) : ""); return; }
    const rounded = Math.round(n);
    if (rounded === Math.round(suggestedQty)) {
      onAccept(rowId, rounded);
    } else {
      onRequestOverride(rowId, Math.round(suggestedQty), rounded);
    }
  }

  return (
    <div className="editable-cell final-qty">
      <input
        type="number" min="0"
        value={local}
        onChange={e => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={e => e.key === "Enter" && e.target.blur()}
      />
    </div>
  );
}

// OverrideModal — unchanged
function OverrideModal({ modal, onConfirm, onCancel }) {
  const [reason, setReason] = useState("");
  useEffect(() => { setReason(""); }, [modal?.rowId]);
  if (!modal) return null;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <AlertTriangle size={16} color="var(--amber)"/>
          <span className="modal-header-title">Override Requires a Reason</span>
          <button className="close-btn" onClick={onCancel}><X size={15}/></button>
        </div>
        <div className="modal-qty-change">
          <span className="modal-qty-from">System suggested: {modal.fromQty} cases</span>
          <span className="modal-qty-arrow">→</span>
          <span className="modal-qty-to">Your qty: {modal.toQty} cases</span>
        </div>
        <p className="modal-prompt">Why are you changing this order quantity?</p>
        <div className="reason-list">
          {OVERRIDE_REASONS.map(r => (
            <label key={r} className={`reason-option ${reason === r ? "selected" : ""}`} onClick={() => setReason(r)}>
              <input type="radio" name="override-reason" value={r} checked={reason === r} readOnly/>
              {r}
            </label>
          ))}
        </div>
        <div className="modal-footer">
          <button className="btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn-confirm" disabled={!reason} onClick={() => reason && onConfirm(reason)}>
            Confirm Override
          </button>
        </div>
      </div>
    </div>
  );
}

// TrendIcon — unchanged
function TrendIcon({ trend }) {
  if (trend === "up")   return <span className="trend-up">  <TrendingUp   size={12}/></span>;
  if (trend === "down") return <span className="trend-down"><TrendingDown size={12}/></span>;
  return <span className="trend-flat"><Minus size={12}/></span>;
}

// ItemDetailDrawer — same data, redesigned visual layout
function ItemDetailDrawer({ item, computed, onClose }) {
  const [notes, setNotes] = useState("");
  const history = useMemo(() => generateHistory(item.predictedUsageBase), [item.id]);
  const menus = MENU_LINKS[item.id] || [];

  return (
    <>
      <div className="drawer-overlay" onClick={onClose}/>
      <div className="drawer">
        {/* Dark header with item identity */}
        <div className="drawer-header">
          <div style={{flex:1,minWidth:0}}>
            <div className="drawer-item-num">{item.itemNumber}</div>
            <div className="drawer-item-name">{item.itemName}</div>
            <div className="drawer-sub-row">
              <span className="drawer-sub-pill">{item.packSize}</span>
              <span className="drawer-sub-pill">{item.volumeClass}</span>
              {item.itemTopCategory && (() => {
                const top = TOP_CATEGORY_MAP[item.itemTopCategory];
                const sub = item.itemSubCategory ? SUB_CATEGORY_MAP[item.itemSubCategory] : null;
                if (!top) return null;
                return (
                  <>
                    <span className="drawer-sub-pill" style={{
                      background: top.bg, border: `1px solid ${top.border}`, color: top.color, fontWeight: 600,
                    }}>{top.shortLabel}</span>
                    {sub && (
                      <span className="drawer-sub-pill" style={{
                        background: top.bg, border: `1px solid ${top.border}`, color: top.color, opacity: 0.8,
                      }}>{sub.label}</span>
                    )}
                  </>
                );
              })()}
              {item.leadTimeWorstCase && (
                <span className="drawer-sub-pill">LT: {item.leadTimeWorstCase}</span>
              )}
            </div>
          </div>
          <button className="close-btn" onClick={onClose}><X size={16}/></button>
        </div>

        <div className="drawer-body">
          {/* Supplier Factors */}
          <div>
            <div className="drawer-section-title"><Truck size={11}/>Supplier Factors</div>
            {!item.supplier && !item.leadTimeWorstCase && item.orderMinimum == null && item.mfrShelfLifeDays == null ? (
              <div style={{fontSize:12,color:"var(--text3)",fontStyle:"italic",padding:"6px 0"}}>
                No supplier data in CSV — add Supplier, Order Minimum, and Guaranteed Shelf Life columns to populate this section.
              </div>
            ) : (
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {/* Supplier name */}
                {item.supplier && (
                  <div className="info-cell">
                    <div className="info-cell-label">Supplier</div>
                    <div className="info-cell-value" style={{fontWeight:600}}>{item.supplier}</div>
                  </div>
                )}

                {/* Delivery Lead Time */}
                {item.leadTimeWorstCase && (() => {
                  const ltDays = computed.leadTimeDays;
                  const ltWarn = ltDays != null && ltDays >= 7;
                  return (
                    <div className={`supplier-factor-card ${ltWarn ? "factor-warn" : "factor-ok"}`}>
                      <div className="factor-icon">{ltWarn ? <AlertTriangle size={13}/> : <CheckCircle size={13}/>}</div>
                      <div style={{flex:1}}>
                        <div className="factor-label">Delivery Lead Time</div>
                        <div className="factor-value">{item.leadTimeWorstCase}{ltDays != null ? ` (${ltDays}d)` : ""}</div>
                        {ltWarn
                          ? <div className="factor-note">Lead time buffer already baked into suggested qty — order covers stock consumed while waiting for delivery.</div>
                          : <div className="factor-note" style={{color:"var(--green)"}}>Short lead time — minimal buffer needed.</div>
                        }
                      </div>
                    </div>
                  );
                })()}

                {/* Order Minimum */}
                {item.orderMinimum != null && (() => {
                  const bumped = computed.bumpedToMin;
                  return (
                    <div className={`supplier-factor-card ${bumped ? "factor-warn" : "factor-ok"}`}>
                      <div className="factor-icon">{bumped ? <AlertTriangle size={13}/> : <CheckCircle size={13}/>}</div>
                      <div style={{flex:1}}>
                        <div className="factor-label">Order Minimum</div>
                        <div className="factor-value">{item.orderMinimum.toLocaleString()} cases</div>
                        {bumped
                          ? <div className="factor-note">Suggested qty was below this minimum and has been snapped up automatically.</div>
                          : <div className="factor-note" style={{color:"var(--green)"}}>Suggested qty meets or exceeds minimum.</div>
                        }
                      </div>
                    </div>
                  );
                })()}

                {/* Guaranteed Shelf Life from Manufacturer */}
                {item.mfrShelfLifeDays != null && (() => {
                  const capped = computed.shelfLifeCapped;
                  const shelfWarn = item.mfrShelfLifeDays < 14;
                  return (
                    <div className={`supplier-factor-card ${capped || shelfWarn ? "factor-warn" : "factor-ok"}`}>
                      <div className="factor-icon">{capped || shelfWarn ? <AlertTriangle size={13}/> : <CheckCircle size={13}/>}</div>
                      <div style={{flex:1}}>
                        <div className="factor-label">Mfr. Guaranteed Shelf Life</div>
                        <div className="factor-value">{item.mfrShelfLifeDays} days on arrival</div>
                        {capped
                          ? <div className="factor-note">Order qty was capped — you can only consume this much before it expires after arrival.</div>
                          : shelfWarn
                            ? <div className="factor-note">Short shelf life on arrival — verify order qty won't expire before it's used.</div>
                            : <div className="factor-note" style={{color:"var(--green)"}}>Shelf life sufficient to consume full order.</div>
                        }
                      </div>
                    </div>
                  );
                })()}

                {/* Adjustment summary */}
                {computed.adjustReasons && computed.adjustReasons.length > 0 && (
                  <div style={{
                    marginTop:4, padding:"9px 12px", borderRadius:"var(--radius)",
                    background:"rgba(26,95,160,0.06)", border:"1px solid rgba(26,95,160,0.18)",
                  }}>
                    <div style={{fontFamily:"var(--head)",fontSize:9,fontWeight:700,letterSpacing:"0.14em",textTransform:"uppercase",color:"var(--blue)",marginBottom:5}}>
                      How the suggested qty was calculated
                    </div>
                    {computed.adjustReasons.map((r,i) => (
                      <div key={i} style={{display:"flex",alignItems:"flex-start",gap:6,fontSize:11,color:"var(--text2)",marginBottom:3}}>
                        <span style={{color:"var(--blue)",marginTop:1,flexShrink:0}}>›</span>{r}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Item Info */}
          <div>
            <div className="drawer-section-title"><Package size={11}/>Item Details</div>
            <div className="drawer-item-info-scroll">
              <div className="info-grid info-grid-horizontal">
                {[
                  ["Unit Price",  `$${item.unitPrice.toFixed(2)}`],
                  ["TI × HI",    item.tixHi],
                  ["On Hand",    item.onHandCount],
                  ["Shelf Life", item.remainingShelfLifeDays == null ? "N/A" : `${item.remainingShelfLifeDays}d`],
                  ["Inbound PO", `${item.inboundPoQty || 0} cs${item.inboundPoEta ? ` · ${item.inboundPoEta}` : ""}`],
                ].map(([label, val]) => (
                  <div className="info-cell" key={label}>
                    <div className="info-cell-label">{label}</div>
                    <div className="info-cell-value">{val}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Order Summary */}
          <div>
            <div className="drawer-section-title"><ShoppingCart size={11}/>Order Summary</div>
            <div className="info-grid">
              {[
                ["Predicted Usage", computed.predictedUsage],
                ["Suggested Qty",   computed.suggestedOrderQty],
                ["Final Qty",       computed.finalOrderQty],
                ["Pallets",         computed.palletCount],
                ["Coverage",        computed.coverageDays == null ? "—" : `${computed.coverageDays.toFixed(1)}d`],
                ["Stockout",        computed.projectedStockoutDate || "Safe"],
              ].map(([label, val]) => (
                <div className="info-cell" key={label}>
                  <div className="info-cell-label">{label}</div>
                  <div className="info-cell-value" style={{
                    color: label === "Final Qty"    ? "var(--amber)"
                      : label === "Coverage"        ? (computed.coverageDays == null ? "var(--text2)" : computed.coverageDays < LOW_COVERAGE_THRESHOLD ? "var(--red)" : computed.coverageDays < 14 ? "var(--amber)" : "var(--green)")
                      : label === "Stockout"        ? (computed.projectedStockoutDate ? "var(--red)" : "var(--green)")
                      : label === "Suggested Qty"   ? "var(--green)"
                      : undefined
                  }}>{val}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Monthly Buy Reference */}
          {item.monthlySuggestion && (
            <div>
              <div className="drawer-section-title"><ClipboardList size={11}/>Monthly Buy Reference (CSV)</div>
              <div className="info-grid">
                {[
                  ["CSV Qty",       item.monthlySuggestion.orderQty],
                  ["Avg Monthly",   item.monthlySuggestion.avgMonthlyUsage],
                  ["Priority",      item.monthlySuggestion.priority],
                  ["Seasonal Peak", item.monthlySuggestion.seasonalPeak ? "Yes" : "No"],
                ].map(([label, val]) => (
                  <div className="info-cell" key={label}>
                    <div className="info-cell-label">{label}</div>
                    <div className="info-cell-value">{val}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Historical Usage Chart */}
          <div>
            <div className="drawer-section-title"><BarChart2 size={11}/>Historical Usage — 8 Weeks</div>
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={history} margin={{top:4,right:4,bottom:0,left:-20}}>
                  <defs>
                    <linearGradient id="usageGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="var(--amber-lt)" stopOpacity={0.25}/>
                      <stop offset="95%" stopColor="var(--amber-lt)" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border2)"/>
                  <XAxis dataKey="week" tick={{fill:"var(--text3)",fontSize:10}} axisLine={false} tickLine={false}/>
                  <YAxis tick={{fill:"var(--text3)",fontSize:10}} axisLine={false} tickLine={false}/>
                  <Tooltip
                    contentStyle={{background:"var(--surface)",border:"1px solid var(--border)",borderRadius:6,fontSize:12,boxShadow:"0 4px 16px rgba(0,0,0,0.1)"}}
                    labelStyle={{color:"var(--text2)"}}
                    itemStyle={{color:"var(--amber)"}}
                  />
                  <Area type="monotone" dataKey="usage" stroke="var(--amber-lt)" strokeWidth={2} fill="url(#usageGrad)" dot={{fill:"var(--amber-lt)",r:3}}/>
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Menu Links */}
          {menus.length > 0 && (
            <div>
              <div className="drawer-section-title"><ClipboardList size={11}/>Used In Menus</div>
              <div className="menu-list">
                {menus.map(m => (
                  <div className="menu-item" key={m}><Package size={12}/>{m}</div>
                ))}
              </div>
            </div>
          )}

          {/* Planner Notes */}
          <div>
            <div className="drawer-section-title">Planner Notes</div>
            <textarea
              className="notes-area"
              placeholder="Add notes for this item…"
              value={notes}
              onChange={e => setNotes(e.target.value)}
            />
          </div>
        </div>
      </div>
    </>
  );
}

// Column widths — unchanged
// 0  Item#   1 Name  2 Pack  3 Price
// 4  OnHand  5 MinSt  6 ShelfLife  7 LeadTime  8 TI×HI  9 InboundPO
// 10 Pred.U  11 Trend
// 12 Sug.Qty 13 Pallets 14 Proj.End
// 15 FinalQty 16 Reason
// 17 Coverage 18 Stockout 19 Pallets 20 EstSpend
const DEFAULT_COL_WIDTHS = [
  90, 200, 110, 80,
  90,  85,  85, 110, 80, 120,
  105,  70,
  105,  78, 110,
   90, 115,  80, 105,
];

// ResizeHandle — unchanged
function ResizeHandle({ colIndex, onResize }) {
  const dragRef = useRef(null);
  function handleMouseDown(e) {
    e.preventDefault(); e.stopPropagation();
    dragRef.current = { startX: e.clientX };
    function onMove(ev) { const d = ev.clientX - dragRef.current.startX; dragRef.current.startX = ev.clientX; onResize(colIndex, d); }
    function onUp() { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); document.body.style.cursor = ""; document.body.style.userSelect = ""; }
    document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
  }
  return <span className="resize-handle" onMouseDown={handleMouseDown} onClick={e => e.stopPropagation()}/>;
}

// ─── FINALIZE VIEW ────────────────────────────────────────────────────────────
// Single-stage: full 11-col table with editable Final Order Qty + export buttons.
function FinalizeView({ computedRows, catTopFilter, catSubFilter, onBack, onRequestOverride, acceptSuggestion }) {
  const [selectedFinalizeId, setSelectedFinalizeId] = useState(null);
  const [finSupplier,        setFinSupplier]        = useState(null); // null = all

  // Step 1 — only items with a positive final order qty
  const allOrderRows = useMemo(() =>
    computedRows.filter(r => r.computed.finalOrderQty > 0),
    [computedRows]
  );

  // Step 2 — apply category filter (mirrors the selection made on the planner)
  const categoryRows = useMemo(() => {
    if (!catTopFilter) return allOrderRows;
    let out = allOrderRows.filter(r => r.itemTopCategory === catTopFilter);
    if (catSubFilter && catSubFilter.size > 0)
      out = out.filter(r => catSubFilter.has(r.itemSubCategory));
    return out;
  }, [allOrderRows, catTopFilter, catSubFilter]);

  // Step 3 — augment with deterministic demo supplier
  const categoryRowsWithSupplier = useMemo(() =>
    categoryRows.map(r => ({ ...r, demoSupplier: getDemoSupplier(r) })),
    [categoryRows]
  );

  // Step 4 — apply supplier filter
  const orderRows = useMemo(() => {
    if (!finSupplier) return categoryRowsWithSupplier;
    return categoryRowsWithSupplier.filter(r => r.demoSupplier.id === finSupplier);
  }, [categoryRowsWithSupplier, finSupplier]);

  const selectedFinalizeRow = selectedFinalizeId
    ? orderRows.find(r => r.id === selectedFinalizeId) || null
    : null;

  const totals = useMemo(() => ({
    items:     orderRows.length,
    pallets:   orderRows.reduce((s, r) => s + r.computed.palletCount, 0),
    spend:     orderRows.reduce((s, r) => s + r.computed.finalOrderQty * r.unitPrice, 0),
    overrides: orderRows.filter(r => !!r.overrideReason).length,
  }), [orderRows]);

  // Active supplier info (used for email / export header)
  const activeSupplierInfo = finSupplier
    ? DEMO_SUPPLIERS.find(s => s.id === finSupplier) || null
    : null;

  // Export PDF — only currently-visible (category + supplier filtered) rows
  function exportPdf() {
    const rows = orderRows.map(r => ({
      itemNumber: r.itemNumber,
      itemName:   r.itemName,
      finalQty:   r.computed.finalOrderQty,
      pallets:    r.computed.palletCount,
    }));
    const supplierLine = activeSupplierInfo
      ? `Supplier: ${activeSupplierInfo.name} &nbsp;·&nbsp; ${activeSupplierInfo.email}`
      : "All Suppliers";
    const rowHtml = rows.map(r => `
      <tr>
        <td class="mono">${r.itemNumber}</td>
        <td>${r.itemName}</td>
        <td class="num">${r.finalQty}</td>
        <td class="num">${r.pallets}</td>
      </tr>`).join("");
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
      <title>FoodBridge Order</title>
      <style>
        body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 12px; color: #1a1714; margin: 32px; }
        h1 { font-size: 18px; font-weight: 700; letter-spacing: 0.06em; margin-bottom: 4px; }
        .sub { font-size: 11px; color: #6b6257; margin-bottom: 20px; }
        table { border-collapse: collapse; width: 100%; }
        thead th { background: #f0ece4; padding: 8px 12px; text-align: left; font-size: 10px;
          font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #6b6257;
          border-bottom: 2px solid #ddd8cf; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        thead th.num { text-align: right; }
        tbody td { padding: 7px 12px; border-bottom: 1px solid #e8e3da; }
        tbody td.num { text-align: right; font-family: monospace; }
        tbody td.mono { font-family: monospace; color: #a85f08; font-size: 11px; }
        tbody tr:nth-child(even) td { background: #f9f7f3; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        @media print { body { margin: 16px; } }
      </style></head><body>
      <h1>FoodBridge — Purchase Order</h1>
      <div class="sub">Generated ${new Date().toLocaleDateString("en-US",{year:"numeric",month:"long",day:"numeric"})} &nbsp;·&nbsp; ${supplierLine}</div>
      <table>
        <thead><tr>
          <th>Item #</th><th>Item Name</th>
          <th class="num">Final Order Qty</th><th class="num">Pallet Count</th>
        </tr></thead>
        <tbody>${rowHtml}</tbody>
      </table>
    </body></html>`;
    const w = window.open("", "_blank");
    w.document.write(html);
    w.document.close();
    w.onload = () => { w.print(); };
  }

  // Export CSV — only currently-visible rows
  function exportCsv() {
    const cols = ["Item #", "Item Name", "Final Order Qty", "Pallet Count"];
    const rowData = orderRows.map(r => {
      const c = r.computed;
      return [r.itemNumber, r.itemName, c.finalOrderQty, c.palletCount]
        .map(v => `"${String(v).replace(/"/g, '""')}"`).join(",");
    });
    const csv = [cols.join(","), ...rowData].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "foodbridge-order.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  // Email Order — opens mailto: with a pre-filled subject and body listing the order
  function emailOrder() {
    const supplier = activeSupplierInfo;
    if (!supplier) return;
    const subject = encodeURIComponent(`FoodBridge Purchase Order — ${new Date().toLocaleDateString("en-US",{year:"numeric",month:"short",day:"numeric"})}`);
    const lines = orderRows.map(r =>
      `  #${r.itemNumber}  ${r.itemName}  |  Qty: ${r.computed.finalOrderQty}  |  Pallets: ${r.computed.palletCount}`
    ).join("\n");
    const body = encodeURIComponent(
      `Hello ${supplier.name},\n\nPlease process the following purchase order:\n\n${lines}\n\nGenerated by FoodBridge on ${new Date().toLocaleDateString("en-US",{year:"numeric",month:"long",day:"numeric"})}.\n\nThank you.`
    );
    window.location.href = `mailto:${supplier.email}?subject=${subject}&body=${body}`;
  }

  return (
    <div style={{display:"flex",flexDirection:"column",height:"100vh",overflow:"hidden",background:"var(--bg)"}}>
      {/* Header */}
      <header className="finalize-header">
        <div className="logo-mark">FoodBridge <span>I--I</span></div>
        <div className="header-sep"/>
        <div className="finalize-title">Order Finalization</div>
        <span className="finalize-step-badge">Review &amp; Export</span>
      </header>

      {/* Toolbar */}
      <div className="finalize-toolbar">
        <button className="btn-back" onClick={onBack}>
          <ArrowLeft size={13}/> Back to Planner
        </button>
        <div className="finalize-stats-strip">
          <div className="finalize-stat">
            <div className="finalize-stat-val">{totals.items}</div>
            <div className="finalize-stat-label">Line Items</div>
          </div>
          <div className="finalize-stat">
            <div className="finalize-stat-val">{totals.pallets}</div>
            <div className="finalize-stat-label">Total Pallets</div>
          </div>
          <div className="finalize-stat">
            <div className="finalize-stat-val" style={{color:"var(--amber)"}}>
              ${totals.spend.toLocaleString("en-US",{maximumFractionDigits:0})}
            </div>
            <div className="finalize-stat-label">Est. Spend</div>
          </div>
          {totals.overrides > 0 && (
            <div className="finalize-stat">
              <div className="finalize-stat-val" style={{color:"var(--amber-lt)"}}>{totals.overrides}</div>
              <div className="finalize-stat-label">Overrides</div>
            </div>
          )}
        </div>
        <div className="finalize-actions">
          <button className="btn-export" onClick={exportCsv} disabled={orderRows.length === 0}>
            <Download size={12}/> Export CSV
          </button>
          <button className="btn-export" onClick={exportPdf} disabled={orderRows.length === 0}>
            <FileText size={12}/> Export PDF
          </button>
          {activeSupplierInfo && (
            <button
              className="btn-export"
              style={{background:"var(--blue-bg)",borderColor:"rgba(26,95,160,0.3)",color:"var(--blue)"}}
              onClick={emailOrder}
              disabled={orderRows.length === 0}
            >
              <CheckCircle size={12}/> Email to {activeSupplierInfo.name}
            </button>
          )}
        </div>
      </div>

      {/* Supplier Filter Bar */}
      <div style={{
        display:"flex", alignItems:"center", gap:12, padding:"8px 24px",
        background:"var(--surface)", borderBottom:"1px solid var(--border)",
        flexShrink:0, flexWrap:"wrap",
      }}>
        <span style={{
          fontFamily:"var(--head)", fontSize:10, fontWeight:700,
          letterSpacing:"0.12em", textTransform:"uppercase", color:"var(--text3)",
          display:"flex", alignItems:"center", gap:5, whiteSpace:"nowrap",
        }}>
          <Truck size={11}/> Supplier
        </span>
        <div className="supplier-pills">
          <button
            className={`pill ${!finSupplier ? "active" : ""}`}
            onClick={() => setFinSupplier(null)}
          >
            All Suppliers
          </button>
          {DEMO_SUPPLIERS.map(s => {
            const count = categoryRowsWithSupplier.filter(r => r.demoSupplier.id === s.id).length;
            return (
              <button
                key={s.id}
                className={`pill ${finSupplier === s.id ? "active" : ""}`}
                onClick={() => setFinSupplier(prev => prev === s.id ? null : s.id)}
                style={finSupplier === s.id ? {background:"var(--blue-bg)",borderColor:"rgba(26,95,160,0.3)",color:"var(--blue)",fontWeight:700} : {}}
              >
                {s.name}
                <span style={{
                  marginLeft:5, fontSize:10, fontFamily:"var(--mono)",
                  opacity:0.65, color: finSupplier === s.id ? "var(--blue)" : "var(--text3)",
                }}>({count})</span>
              </button>
            );
          })}
        </div>
        {activeSupplierInfo && (
          <span style={{marginLeft:"auto",fontSize:11,color:"var(--text3)",fontFamily:"var(--mono)"}}>
            → {activeSupplierInfo.email}
          </span>
        )}
      </div>

      {/* Legend strip */}
      <div style={{
        display:"flex", alignItems:"center", gap:20, padding:"7px 24px",
        background:"var(--surface)", borderBottom:"1px solid var(--border2)",
        flexShrink:0, flexWrap:"wrap",
      }}>
        <span style={{fontSize:11,fontFamily:"var(--head)",fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:"var(--text3)"}}>Legend</span>
        <span style={{display:"flex",alignItems:"center",gap:6,fontSize:11,color:"var(--text2)"}}>
          <span style={{width:12,height:12,borderRadius:3,background:"var(--amber-bg)",border:"1px solid var(--amber-br)",display:"inline-block"}}/>
          Final Order Qty (editable)
        </span>
        <span style={{display:"flex",alignItems:"center",gap:6,fontSize:11,color:"var(--text2)"}}>
          <span style={{width:3,height:14,borderRadius:2,background:"var(--amber-lt)",display:"inline-block"}}/>
          Override applied
        </span>
        <span style={{display:"flex",alignItems:"center",gap:6,fontSize:11,color:"var(--text2)"}}>
          <span className="sug-qty-chip" style={{fontSize:10,padding:"1px 6px"}}>n</span>
          AI suggestion
        </span>
        <span style={{display:"flex",alignItems:"center",gap:6,fontSize:11,color:"var(--text2)"}}>
          <span className="proj-end-chip danger" style={{fontSize:10,padding:"1px 6px"}}>n</span>
          Stockout risk
        </span>
        {catTopFilter && (() => {
          const top = TOP_CATEGORY_MAP[catTopFilter];
          return top ? (
            <span style={{
              display:"inline-flex", alignItems:"center", gap:6,
              background: top.bg, border:`1px solid ${top.border}`,
              borderRadius:4, padding:"2px 9px", fontSize:11,
              color: top.color, fontFamily:"var(--head)", fontWeight:600,
            }}>
              <Filter size={10}/> {top.shortLabel}
            </span>
          ) : null;
        })()}
        <span style={{fontSize:11,color:"var(--text3)",marginLeft:"auto",fontFamily:"var(--mono)"}}>
          Exports: Item # · Name · Final Qty · Pallets
        </span>
      </div>

      {/* Full 11-col table — Final Order Qty is editable */}
      <div className="finalize-grid">
        {orderRows.length === 0 ? (
          <div className="empty-state">
            <Package size={44}/>
            <div className="empty-title">No items to order</div>
            <div className="empty-sub">
              {categoryRows.length === 0
                ? "No items with positive order quantities in the selected category."
                : finSupplier
                  ? `No items from ${DEMO_SUPPLIERS.find(s => s.id === finSupplier)?.name} in this category. Try a different supplier.`
                  : "All suggested quantities are zero. Adjust filters or inventory data."
              }
            </div>
          </div>
        ) : (
          <table className="fin-table fin-fill">
            <colgroup>
              <col style={{width:85}}/>
              <col style={{width:190}}/>
              <col style={{width:110}}/>
              <col style={{width:100}}/>
              <col style={{width:120}}/>
              <col style={{width:130}}/>
              <col style={{width:100}}/>
              <col style={{width:160}}/>
              <col style={{width:110}}/>
              <col style={{width:130}}/>
              <col style={{width:110}}/>
              <col/>
            </colgroup>
            <thead>
              <tr>
                <th style={{textAlign:"left"}}>Item #</th>
                <th style={{textAlign:"left"}}>Item Name</th>
                <th>Sug. Qty</th>
                <th>Sug. Pallets</th>
                <th>Proj. End Inv</th>
                <th className="fin-key">Final Order Qty</th>
                <th>Final Pallets</th>
                <th>Override Reason</th>
                <th>Coverage Days</th>
                <th>Stockout Date</th>
                <th>Est. Spend</th>
                <th className="fin-spacer" aria-label="spacer"/>
              </tr>
            </thead>
            <tbody>
              {orderRows.map(row => {
                const c = row.computed;
                const hasOverride  = !!row.overrideReason;
                const sugPallets   = Math.ceil(c.suggestedOrderQty / Math.max(parseTixHi(row.tixHi), 1));
                const projEndClass = c.projectedEndingInventory < 0 ? "danger"
                  : c.projectedEndingInventory < row.minStockLevel ? "warn" : "ok";
                const isCrit       = c.coverageDays != null && c.coverageDays < LOW_COVERAGE_THRESHOLD;
                const isCaution    = !isCrit && c.coverageDays != null && c.coverageDays < 14;

                return (
                  <tr
                    key={row.id}
                    className={hasOverride ? "fin-override" : ""}
                    onClick={() => setSelectedFinalizeId(id => id === row.id ? null : row.id)}
                    style={{cursor:"pointer"}}
                  >
                    <td><span className="item-number">{row.itemNumber}</span></td>
                    <td>
                      <span className="item-name" title={row.itemName}>{row.itemName}</span>
                      <span style={{marginLeft:6,fontSize:10,color:"var(--blue)",fontFamily:"var(--mono)",opacity:0.7}}>› details</span>
                    </td>

                    {/* Sug. Qty */}
                    <td className="cell-num">
                      {c.suggestedOrderQty > 0
                        ? <span className="sug-qty-chip">{c.suggestedOrderQty}</span>
                        : <span className="cell-muted">—</span>}
                    </td>

                    {/* Sug. Pallets */}
                    <td className="cell-num" style={{color:"var(--text2)"}}>
                      {c.suggestedOrderQty > 0 ? sugPallets : <span className="cell-muted">—</span>}
                    </td>

                    {/* Proj. End Inv */}
                    <td>
                      <span className={`proj-end-chip ${projEndClass}`}>{c.projectedEndingInventory}</span>
                    </td>

                    {/* Final Order Qty — editable */}
                    <td className="fin-key" onClick={e => e.stopPropagation()}>
                      <FinalQtyCell
                        rowId={row.id}
                        value={row.finalOrderQty}
                        suggestedQty={c.suggestedOrderQty}
                        onRequestOverride={onRequestOverride}
                        onAccept={acceptSuggestion}
                      />
                    </td>

                    {/* Final Pallets */}
                    <td className="cell-num">{c.palletCount}</td>

                    {/* Override Reason */}
                    <td>
                      {hasOverride ? (
                        <span style={{
                          display:"inline-flex", alignItems:"center", gap:5,
                          background:"rgba(168,95,8,0.06)", border:"1px solid var(--amber-br)",
                          borderRadius:4, padding:"2px 8px",
                          fontSize:11, color:"var(--amber)", fontFamily:"var(--ui)",
                          maxWidth:155, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                        }} title={row.overrideReason}>
                          <AlertTriangle size={10}/>{row.overrideReason}
                        </span>
                      ) : (
                        <span className="cell-muted" style={{fontSize:11}}>—</span>
                      )}
                    </td>

                    {/* Coverage Days */}
                    <td>
                      <span className={`coverage-bar ${isCrit ? "coverage-crit" : isCaution ? "coverage-warn" : "coverage-ok"}`}>
                        {isCrit && <AlertTriangle size={10}/>}
                        {c.coverageDays != null ? `${c.coverageDays.toFixed(1)}d` : "—"}
                      </span>
                    </td>

                    {/* Stockout Date */}
                    <td>
                      {c.projectedStockoutDate
                        ? <span className="stockout-badge"><AlertTriangle size={10}/>{c.projectedStockoutDate}</span>
                        : <span className="cell-muted" style={{fontSize:11}}>—</span>}
                    </td>

                    {/* Est. Spend */}
                    <td className="cell-num">
                      ${(c.finalOrderQty * row.unitPrice).toLocaleString("en-US",{maximumFractionDigits:0})}
                    </td>
                    <td className="fin-spacer"/>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Item Detail Drawer — click any row to open */}
      {selectedFinalizeRow && (
        <ItemDetailDrawer
          item={selectedFinalizeRow}
          computed={selectedFinalizeRow.computed}
          onClose={() => setSelectedFinalizeId(null)}
        />
      )}
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function FoodBridge() {
  const [horizonDays,      setHorizonDays]      = useState(PLANNING_HORIZON_DAYS);
  const [search,           setSearch]           = useState("");
  const [onlyNeeded,       setOnlyNeeded]       = useState(false);
  const [suppFilter,       setSuppFilter]       = useState(new Set());
  const [rows,             setRows]             = useState([]);
  const [inventoryLoading, setInventoryLoading] = useState(true);
  const [inventoryError,   setInventoryError]   = useState("");
  const [selectedId,       setSelectedId]       = useState(null);
  const [sortKey,          setSortKey]          = useState(null);
  const [sortDir,          setSortDir]          = useState("asc");
  const [colWidths,        setColWidths]        = useState(DEFAULT_COL_WIDTHS);
  const [overrideModal,    setOverrideModal]    = useState(null);
  const [showFinalize,     setShowFinalize]     = useState(false);
  const [supplierFilter,   setSupplierFilter]   = useState(new Set());
  const [catTopFilter,     setCatTopFilter]     = useState(null);
  const [catSubFilter,     setCatSubFilter]     = useState(new Set());

  // ── Data loading (unchanged) ──
  useEffect(() => {
    let cancelled = false;
    async function loadInventory() {
      try {
        setInventoryLoading(true); setInventoryError("");
        const [invRes, sugRes] = await Promise.all([
          fetch(`${import.meta.env.BASE_URL}Inventory_Master_Analysis_final.csv`),
          fetch(`${import.meta.env.BASE_URL}Monthly_Buy_Suggestions.csv`),
        ]);
        if (!invRes.ok) throw new Error(`Failed to load inventory CSV (${invRes.status})`);

        const [invText, sugText] = await Promise.all([invRes.text(), sugRes.ok ? sugRes.text() : Promise.resolve("")]);
        const suggestions = sugText ? parseMonthlySuggestionsCsv(sugText) : [];
        const suggestionMap = new Map(suggestions.map(s => [normalizeProductName(s.product), s]));

        const inventoryRows = parseInventoryCsv(invText).map(item => ({
          ...item,
          monthlySuggestion: suggestionMap.get(normalizeProductName(item.itemName)) || null,
        }));

        if (!cancelled) {
          setRows(inventoryRows);
          setSuppFilter(new Set(inventoryRows.map(r => r.primarySupplier)));
        }
      } catch (err) {
        if (!cancelled) {
          setRows([]);
          setInventoryError(err instanceof Error ? err.message : "Unable to load inventory CSV");
        }
      } finally {
        if (!cancelled) setInventoryLoading(false);
      }
    }
    loadInventory();
    return () => { cancelled = true; };
  }, []);

  const handleResize = useCallback((colIndex, delta) => {
    setColWidths(prev => { const n = [...prev]; n[colIndex] = Math.max(40, n[colIndex] + delta); return n; });
  }, []);

  const updateRow = useCallback((id, field, value) => {
    setRows(prev => prev.map(r => r.id === id ? { ...r, [field]: value } : r));
  }, []);

  // Override modal handlers (unchanged)
  function handleRequestOverride(rowId, fromQty, toQty) { setOverrideModal({ rowId, fromQty, toQty }); }
  function confirmOverride(reason) {
    if (!overrideModal) return;
    updateRow(overrideModal.rowId, "finalOrderQty",  overrideModal.toQty);
    updateRow(overrideModal.rowId, "overrideReason", reason);
    setOverrideModal(null);
  }
  function cancelOverride() { setOverrideModal(null); }
  function acceptSuggestion(rowId, value) {
    updateRow(rowId, "finalOrderQty",  value);
    updateRow(rowId, "overrideReason", "");
  }

  const allSuppliers = useMemo(() =>
    [...new Set(rows.map(r => (r.primarySupplier ?? "").trim()))].filter(Boolean).sort(), [rows]);

  const allSupplierNames = useMemo(() =>
    [...new Set(rows.map(r => (r.supplier ?? "").trim()))].filter(Boolean).sort(), [rows]);

  const computedRows = useMemo(() =>
    rows.map(r => ({ ...r, computed: computeRow(r, horizonDays) })),
    [rows, horizonDays]
  );

  const filteredRows = useMemo(() => {
    let out = computedRows;
    if (search.trim()) {
      const q = search.toLowerCase();
      out = out.filter(r => r.itemName.toLowerCase().includes(q) || r.itemNumber.toLowerCase().includes(q));
    }
    if (onlyNeeded) out = out.filter(r => r.computed.suggestedOrderQty > 0);
    if (suppFilter.size > 0) out = out.filter(r => suppFilter.has((r.primarySupplier ?? "").trim()));
    if (supplierFilter.size > 0) out = out.filter(r => supplierFilter.has((r.supplier ?? "").trim()));
    if (catTopFilter) {
      out = out.filter(r => r.itemTopCategory === catTopFilter);
      if (catSubFilter.size > 0) out = out.filter(r => catSubFilter.has(r.itemSubCategory));
    }
    if (sortKey) {
      out = [...out].sort((a, b) => {
        if (sortKey === "coverageDays") {
          const av = Number.isFinite(a.computed.coverageDays) ? a.computed.coverageDays : Infinity;
          const bv = Number.isFinite(b.computed.coverageDays) ? b.computed.coverageDays : Infinity;
          return sortDir === "asc" ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
        }
        let av = a.computed[sortKey] ?? a[sortKey] ?? 0;
        let bv = b.computed[sortKey] ?? b[sortKey] ?? 0;
        if (typeof av === "string") av = av.toLowerCase();
        if (typeof bv === "string") bv = bv.toLowerCase();
        return sortDir === "asc" ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
      });
    }
    return out;
  }, [computedRows, search, onlyNeeded, suppFilter, supplierFilter, catTopFilter, catSubFilter, sortKey, sortDir]);

  // Summary stats (unchanged)
  const summary = useMemo(() => {
    const totalSpend       = filteredRows.reduce((s, r) => s + r.computed.finalOrderQty * r.unitPrice, 0);
    const atRisk           = filteredRows.filter(r => r.computed.coverageDays != null && r.computed.coverageDays < LOW_COVERAGE_THRESHOLD).length;
    const totalPallets     = filteredRows.reduce((s, r) => s + (r.computed.suggestedOrderQty > 0 ? r.computed.palletCount : 0), 0);
    const trucksNeeded     = totalPallets === 0 ? 0 : Math.ceil(totalPallets / TRUCK_CAPACITY_PALLETS);
    const lastTruckPallets = totalPallets === 0 ? 0 : (totalPallets % TRUCK_CAPACITY_PALLETS || TRUCK_CAPACITY_PALLETS);
    const lastTruckFillPct = totalPallets === 0 ? 0 : Math.round((lastTruckPallets / TRUCK_CAPACITY_PALLETS) * 100);
    return { totalSpend, atRisk, totalPallets, trucksNeeded, lastTruckPallets, lastTruckFillPct };
  }, [filteredRows]);

  function handleSort(key) {
    setSortDir(d => sortKey === key ? (d === "asc" ? "desc" : "asc") : "asc");
    setSortKey(key);
  }

  function SortIcon({ k }) {
    if (sortKey !== k) return <ChevronsUpDown size={10} className="sort-icon"/>;
    return sortDir === "asc" ? <ChevronUp size={10} className="sort-icon active"/> : <ChevronDown size={10} className="sort-icon active"/>;
  }

  function toggleSupplier(s) {
    const key = (s ?? "").trim();
    setSuppFilter(prev => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  }
  function toggleSupplierName(s) {
    const key = (s ?? "").trim();
    setSupplierFilter(prev => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  }
  function selectTopCategory(k) {
    if (catTopFilter === k) { setCatTopFilter(null); setCatSubFilter(new Set()); }
    else { setCatTopFilter(k); setCatSubFilter(new Set()); }
  }
  function toggleSubCategory(k) {
    setCatSubFilter(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  }

  const selectedRow = selectedId ? computedRows.find(r => r.id === selectedId) : null;

  useEffect(() => {
    if (!selectedRow) return;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, [selectedRow]);

  const fillColor = summary.lastTruckFillPct >= 90 ? "var(--green)" : summary.lastTruckFillPct >= 60 ? "var(--amber-lt)" : "var(--red)";

  // ── Finalize View ──
  if (showFinalize) {
    return (
      <>
        <style>{STYLES}</style>
        <FinalizeView
          computedRows={computedRows}
          catTopFilter={catTopFilter}
          catSubFilter={catSubFilter}
          onBack={() => setShowFinalize(false)}
          onRequestOverride={handleRequestOverride}
          acceptSuggestion={acceptSuggestion}
        />
        <OverrideModal modal={overrideModal} onConfirm={confirmOverride} onCancel={cancelOverride}/>
      </>
    );
  }

  // ── Primary Planning View ──
  return (
    <>
      <style>{STYLES}</style>
      <div className="app">

        {/* HEADER */}
        <header className="app-header">
          <div className="logo-mark">FoodBridge <span>I--I</span></div>
          <div className="header-sep"/>
          <div className="page-title">Purchase Planner</div>
          <div className="header-spacer"/>
          <div className="badge">
            <Calendar size={11}/>
            {HORIZON_OPTIONS.find(h => h.days === horizonDays)?.label ?? `${horizonDays}d horizon`}
          </div>
        </header>

        {/* FILTERS */}
        <div className="filters-panel">
          <div className="search-wrap">
            <Search size={13}/>
            <input
              className="search-input" type="text"
              placeholder="Search item name or #…"
              value={search} onChange={e => setSearch(e.target.value)}
            />
          </div>
          <div className="header-sep"/>
          <div className="filter-group">
            <span className="filter-label"><Calendar size={11}/> Horizon</span>
            <select className="fp-select" value={horizonDays} onChange={e => setHorizonDays(Number(e.target.value))}>
              {HORIZON_OPTIONS.map(h => <option key={h.days} value={h.days}>{h.label}</option>)}
            </select>
          </div>
          <div className="header-sep"/>
          <button className={`toggle-btn ${onlyNeeded ? "active" : ""}`} onClick={() => setOnlyNeeded(v => !v)}>
            <Filter size={11}/> Order needed
          </button>
          <div className="header-sep"/>
          <div className="filter-group">
            <span className="filter-label">Class</span>
            <div className="supplier-pills">
              {allSuppliers.map(s => (
                <button key={s} className={`pill ${suppFilter.has(s) ? "active" : ""}`} onClick={() => toggleSupplier(s)}>{s}</button>
              ))}
            </div>
          </div>
          <div className="header-sep"/>
          <div className="filter-group" style={{flexDirection:"column",alignItems:"flex-start",gap:6}}>
            <span className="filter-label">Category</span>
            {/* Row 1 — top-level procurement categories */}
            <div className="supplier-pills">
              {PROCUREMENT_TAXONOMY.map(top => {
                const active = catTopFilter === top.key;
                return (
                  <button
                    key={top.key}
                    onClick={() => selectTopCategory(top.key)}
                    className="pill"
                    style={active ? {
                      background: top.bg,
                      borderColor: top.border,
                      color: top.color,
                      fontWeight: 700,
                    } : {}}
                  >
                    {top.shortLabel}
                  </button>
                );
              })}
            </div>
            {/* Row 2 — sub-categories (only when a top category is selected) */}
            {catTopFilter && (() => {
              const top = TOP_CATEGORY_MAP[catTopFilter];
              if (!top) return null;
              return (
                <div className="supplier-pills" style={{marginLeft:4}}>
                  {top.subs.map(sub => {
                    const active = catSubFilter.has(sub.key);
                    return (
                      <button
                        key={sub.key}
                        onClick={() => toggleSubCategory(sub.key)}
                        className="pill"
                        style={active ? {
                          background: top.bg,
                          borderColor: top.border,
                          color: top.color,
                        } : {opacity:0.65}}
                      >
                        {sub.label}
                      </button>
                    );
                  })}
                </div>
              );
            })()}
          </div>
          {allSupplierNames.length > 0 && (
            <>
              <div className="header-sep"/>
              <div className="filter-group">
                <span className="filter-label"><Truck size={11}/> Supplier</span>
                {allSupplierNames.length <= 7 ? (
                  <div className="supplier-pills">
                    {allSupplierNames.map(s => (
                      <button key={s} className={`pill ${supplierFilter.has(s) ? "active" : ""}`} onClick={() => toggleSupplierName(s)}>{s}</button>
                    ))}
                  </div>
                ) : (
                  <select
                    className="fp-select"
                    value={supplierFilter.size === 1 ? [...supplierFilter][0] : ""}
                    onChange={e => setSupplierFilter(e.target.value ? new Set([e.target.value]) : new Set())}
                  >
                    <option value="">All suppliers</option>
                    {allSupplierNames.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                )}
              </div>
            </>
          )}
        </div>

        {/* SUMMARY BAR */}
        <div className="summary-bar">
          <div className="stat-card">
            <div className="stat-icon amber"><Layers size={16}/></div>
            <div>
              <div className="stat-value">{filteredRows.length}</div>
              <div className="stat-label">Items Shown</div>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon blue"><DollarSign size={16}/></div>
            <div>
              <div className="stat-value">${summary.totalSpend.toLocaleString("en-US",{maximumFractionDigits:0})}</div>
              <div className="stat-label">Planned Spend</div>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon red"><AlertTriangle size={16}/></div>
            <div>
              <div className="stat-value" style={{color: summary.atRisk > 0 ? "var(--red)" : "var(--green)"}}>
                {summary.atRisk}
              </div>
              <div className="stat-label">At-Risk (&lt;{LOW_COVERAGE_THRESHOLD}d)</div>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon green"><Package size={16}/></div>
            <div>
              <div className="stat-value">{summary.totalPallets}</div>
              <div className="stat-label">Total Pallets</div>
            </div>
          </div>
          <div className="stat-card truck-fill-card">
            <div className="stat-icon purple"><Truck size={16}/></div>
            <div>
              <div className="stat-value" style={{color: fillColor}}>
                {summary.trucksNeeded} truck{summary.trucksNeeded !== 1 ? "s" : ""}
              </div>
              <div className="stat-label">
                Last: {summary.lastTruckPallets}/{TRUCK_CAPACITY_PALLETS} pal. ({summary.lastTruckFillPct}% full)
              </div>
              <div className="truck-fill-wrap">
                <div className="truck-fill-track">
                  <div className="truck-fill-fill" style={{width:`${summary.lastTruckFillPct}%`,background:fillColor}}/>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* TABLE GRID */}
        <div className="grid-container">
          {inventoryLoading ? (
            <div className="empty-state">
              <Package size={44}/>
              <div className="empty-title">Loading inventory…</div>
              <div className="empty-sub">Reading Inventory_Master_Analysis_final.csv</div>
            </div>
          ) : inventoryError ? (
            <div className="empty-state">
              <AlertTriangle size={44}/>
              <div className="empty-title">CSV could not be loaded</div>
              <div className="empty-sub">{inventoryError}</div>
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="empty-state">
              <Package size={44}/>
              <div className="empty-title">No items match filters</div>
              <div className="empty-sub">Try adjusting search or class filters above.</div>
            </div>
          ) : (
            <table className="fp-table">
              <colgroup>
                {colWidths.map((w, i) => <col key={i} style={{width:w,minWidth:w}}/>)}
                <col/>
              </colgroup>
              <thead>
                {/* ── Group row (colspans = 19) ── */}
                <tr className="group-row">
                  <th colSpan={4}  className="g-base  col-group-item">Item Info</th>
                  <th colSpan={8}  className="g-inv   col-group-inv">Inventory · Demand</th>
                  <th colSpan={3}  className="g-ai    col-group-sug">AI Suggestion</th>
                  <th colSpan={5}  className="g-impact col-group-impact">Impact</th>
                </tr>
                {/* ── Column header row ── */}
                <tr className="col-row">
                  {/* Base — cols 0–3 */}
                  <th className="g-base" style={{width:colWidths[0],textAlign:"left"}} onClick={()=>handleSort("itemNumber")}>
                    <div className="th-inner left">Item # <SortIcon k="itemNumber"/><ColTooltip colKey="itemNumber"/></div>
                    <ResizeHandle colIndex={0} onResize={handleResize}/>
                  </th>
                  <th className="g-base" style={{width:colWidths[1],textAlign:"left"}} onClick={()=>handleSort("itemName")}>
                    <div className="th-inner left">Name <SortIcon k="itemName"/><ColTooltip colKey="itemName"/></div>
                    <ResizeHandle colIndex={1} onResize={handleResize}/>
                  </th>
                  <th className="g-base" style={{width:colWidths[2]}}>
                    <div className="th-inner">Pack Size<ColTooltip colKey="packSize"/></div>
                    <ResizeHandle colIndex={2} onResize={handleResize}/>
                  </th>
                  <th className="g-base" style={{width:colWidths[3]}} onClick={()=>handleSort("unitPrice")}>
                    <div className="th-inner">Price <SortIcon k="unitPrice"/><ColTooltip colKey="unitPrice"/></div>
                    <ResizeHandle colIndex={3} onResize={handleResize}/>
                  </th>
                  {/* Inventory + Demand — cols 4–11 */}
                  <th className="g-inv" style={{width:colWidths[4]}} onClick={()=>handleSort("onHandCount")}>
                    <div className="th-inner">On Hand <SortIcon k="onHandCount"/><ColTooltip colKey="onHandCount"/></div>
                    <ResizeHandle colIndex={4} onResize={handleResize}/>
                  </th>
                  <th className="g-inv" style={{width:colWidths[5]}}>
                    <div className="th-inner">Min Stock<ColTooltip colKey="minStockLevel"/></div>
                    <ResizeHandle colIndex={5} onResize={handleResize}/>
                  </th>
                  <th className="g-inv" style={{width:colWidths[6]}}>
                    <div className="th-inner">Shelf Life<ColTooltip colKey="remainingShelfLifeDays"/></div>
                    <ResizeHandle colIndex={6} onResize={handleResize}/>
                  </th>
                  <th className="g-inv" style={{width:colWidths[7]}}>
                    <div className="th-inner">Lead Time<ColTooltip colKey="leadTimeWorstCase"/></div>
                    <ResizeHandle colIndex={7} onResize={handleResize}/>
                  </th>
                  <th className="g-inv" style={{width:colWidths[8]}}>
                    <div className="th-inner">TI×HI<ColTooltip colKey="tixHi"/></div>
                    <ResizeHandle colIndex={8} onResize={handleResize}/>
                  </th>
                  <th className="g-inv" style={{width:colWidths[9]}}>
                    <div className="th-inner">Inbound PO<ColTooltip colKey="inboundPoQty"/></div>
                    <ResizeHandle colIndex={9} onResize={handleResize}/>
                  </th>
                  <th className="g-inv" style={{width:colWidths[10]}} onClick={()=>handleSort("predictedUsage")}>
                    <div className="th-inner">Pred. Usage <SortIcon k="predictedUsage"/><ColTooltip colKey="predictedUsage"/></div>
                    <ResizeHandle colIndex={10} onResize={handleResize}/>
                  </th>
                  <th className="g-inv" style={{width:colWidths[11]}}>
                    <div className="th-inner">Trend<ColTooltip colKey="demandTrend"/></div>
                    <ResizeHandle colIndex={11} onResize={handleResize}/>
                  </th>
                  {/* AI Suggestion — cols 12–14 */}
                  <th className="g-ai" style={{width:colWidths[12]}} onClick={()=>handleSort("suggestedOrderQty")}>
                    <div className="th-inner">Sug. Qty <SortIcon k="suggestedOrderQty"/><ColTooltip colKey="suggestedOrderQty"/></div>
                    <ResizeHandle colIndex={12} onResize={handleResize}/>
                  </th>
                  <th className="g-ai" style={{width:colWidths[13]}}>
                    <div className="th-inner">Pallets<ColTooltip colKey="monthlySuggestedPallets"/></div>
                    <ResizeHandle colIndex={13} onResize={handleResize}/>
                  </th>
                  <th className="g-ai" style={{width:colWidths[14]}}>
                    <div className="th-inner">Proj. End Inv<ColTooltip colKey="projectedEndingInventory"/></div>
                    <ResizeHandle colIndex={14} onResize={handleResize}/>
                  </th>
                  {/* Impact — cols 15–18 */}
                  <th className="g-impact" style={{width:colWidths[15]}} onClick={()=>handleSort("coverageDays")}>
                    <div className="th-inner">Coverage <SortIcon k="coverageDays"/><ColTooltip colKey="coverageDays"/></div>
                    <ResizeHandle colIndex={15} onResize={handleResize}/>
                  </th>
                  <th className="g-impact" style={{width:colWidths[16]}}>
                    <div className="th-inner">Stockout Date<ColTooltip colKey="projectedStockoutDate"/></div>
                    <ResizeHandle colIndex={16} onResize={handleResize}/>
                  </th>
                  <th className="g-impact" style={{width:colWidths[17]}}>
                    <div className="th-inner">Pallets<ColTooltip colKey="palletCount"/></div>
                    <ResizeHandle colIndex={17} onResize={handleResize}/>
                  </th>
                  <th className="g-impact" style={{width:colWidths[18]}}>
                    <div className="th-inner">Est. Spend<ColTooltip colKey="estSpend"/></div>
                    <ResizeHandle colIndex={18} onResize={handleResize}/>
                  </th>
                  <th className="g-impact fp-spacer" aria-label="spacer"/>
                </tr>
              </thead>

              <tbody>
                {filteredRows.map(row => {
                  const c = row.computed;
                  const isCrit    = c.coverageDays != null && c.coverageDays < LOW_COVERAGE_THRESHOLD;
                  const isCaution = !isCrit && c.coverageDays != null && c.coverageDays < 14;
                  const isSelected = row.id === selectedId;
                  const rowClass = [
                    isCrit    ? "warn-critical" : "",
                    isCaution ? "warn-caution"  : "",
                    isSelected ? "selected"     : "",
                  ].filter(Boolean).join(" ");

                  const casesPerPallet = parseTixHi(row.tixHi);
                  const suggestedPallets = Math.ceil(c.suggestedOrderQty / Math.max(casesPerPallet, 1));
                  const projEndClass = c.projectedEndingInventory < 0 ? "danger"
                    : c.projectedEndingInventory < row.minStockLevel ? "warn" : "ok";

                  return (
                    <tr
                      key={row.id}
                      className={rowClass}
                      onClick={() => setSelectedId(id => id === row.id ? null : row.id)}
                      style={{cursor:"pointer"}}
                    >
                      {/* Base — cols 0–3 */}
                      <td className="g-base"><span className="item-number">{row.itemNumber}</span></td>
                      <td className="g-base"><span className="item-name" title={row.itemName}>{row.itemName}</span></td>
                      <td className="g-base cell-muted" style={{textAlign:"left",fontSize:11}}>{row.packSize}</td>
                      <td className="g-base cell-num">${row.unitPrice.toFixed(2)}</td>

                      {/* Inventory — cols 4–9 */}
                      <td className="g-inv" onClick={e => e.stopPropagation()}>
                        <EditableCell value={row.onHandCount} onChange={v => updateRow(row.id, "onHandCount", v ?? 0)}/>
                      </td>
                      <td className="g-inv" onClick={e => e.stopPropagation()}>
                        <EditableCell value={row.minStockLevel} onChange={v => updateRow(row.id, "minStockLevel", v ?? 0)}/>
                      </td>
                      <td className="g-inv cell-num" style={{
                        color: row.remainingShelfLifeDays == null ? "var(--text3)"
                          : row.remainingShelfLifeDays <= 7  ? "var(--red)"
                          : row.remainingShelfLifeDays <= 14 ? "var(--amber)"
                          : "var(--text2)"
                      }}>
                        {row.remainingShelfLifeDays == null ? "N/A" : `${row.remainingShelfLifeDays}d`}
                        {c.shelfLifeGate && (
                          <span className="shelf-gate-icon" title="Existing stock expires before horizon midpoint — verify before adding more">
                            <AlertTriangle size={10}/>
                          </span>
                        )}
                      </td>
                      <td className="g-inv cell-muted" style={{textAlign:"left",fontSize:11}}>{row.leadTimeWorstCase || "—"}</td>
                      <td className="g-inv cell-mono cell-muted">{row.tixHi}</td>
                      <td className="g-inv" onClick={e => e.stopPropagation()}>
                        <div className="inbound-cell">
                          <div className="editable-cell inbound-qty">
                            <input
                              type="number" min="0"
                              value={row.inboundPoQty || ""}
                              placeholder="0"
                              onChange={e => {
                                const v = parseFloat(e.target.value);
                                updateRow(row.id, "inboundPoQty", isNaN(v) ? 0 : v);
                              }}
                              style={{
                                width:60,
                                background:"var(--blue-bg)",
                                borderColor:"rgba(26,95,160,0.2)",
                                color:"var(--blue)"
                              }}
                            />
                          </div>
                          <input
                            type="text"
                            className="inbound-eta-input"
                            placeholder="ETA date"
                            value={row.inboundPoEta || ""}
                            onChange={e => updateRow(row.id, "inboundPoEta", e.target.value)}
                          />
                        </div>
                      </td>

                      {/* Demand — cols 10–11 */}
                      <td className="g-inv cell-num">{c.predictedUsage}</td>
                      <td className="g-inv"><TrendIcon trend={row.demandTrend}/></td>

                      {/* AI Suggestion — cols 12–14 */}
                      <td className="g-ai cell-num">
                        {c.suggestedOrderQty > 0
                          ? <span className="sug-qty-chip">{c.suggestedOrderQty}</span>
                          : <span className="cell-muted">—</span>
                        }
                      </td>
                      <td className="g-ai cell-num" style={{color:"var(--text2)"}}>
                        {c.suggestedOrderQty > 0 ? suggestedPallets : <span className="cell-muted">—</span>}
                      </td>
                      <td className="g-ai">
                        <span className={`proj-end-chip ${projEndClass}`}>{c.projectedEndingInventory}</span>
                      </td>

                      {/* Impact — cols 15–18 */}
                      <td className="g-impact">
                        <span className={`coverage-bar ${isCrit ? "coverage-crit" : isCaution ? "coverage-warn" : "coverage-ok"}`}>
                          {isCrit && <AlertTriangle size={11}/>}
                          {c.coverageDays == null ? "—" : `${c.coverageDays.toFixed(1)}d`}
                        </span>
                      </td>
                      <td className="g-impact">
                        {c.projectedStockoutDate
                          ? <span className="stockout-badge"><AlertTriangle size={10}/>{c.projectedStockoutDate}</span>
                          : <span className="cell-muted" style={{fontSize:11}}>—</span>
                        }
                      </td>
                      <td className="g-impact cell-num">{c.palletCount}</td>
                      <td className="g-impact cell-num">
                        ${(c.finalOrderQty * row.unitPrice).toLocaleString("en-US",{maximumFractionDigits:0})}
                      </td>
                      <td className="g-impact fp-spacer"/>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* DETAIL DRAWER */}
        {selectedRow && (
          <ItemDetailDrawer
            item={selectedRow}
            computed={selectedRow.computed}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>

      {/* FAB — Finalize Order */}
      <button className="fab" onClick={() => setShowFinalize(true)}>
        <ClipboardList size={15}/>
        Finalize Order
      </button>

      {/* OVERRIDE MODAL */}
      <OverrideModal modal={overrideModal} onConfirm={confirmOverride} onCancel={cancelOverride}/>
    </>
  );
}