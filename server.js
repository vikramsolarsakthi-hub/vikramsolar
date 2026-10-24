const express = require("express");
const path = require("path");
const fs = require("fs");
const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const ROUTES_FILE = path.join(__dirname, "routes.json");
const BATCHES_FILE = path.join(__dirname, "batches.json");

function loadJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch (err) {
    console.error(`Error reading ${filePath}:`, err);
  }
  return [];
}

function saveJSON(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error(`Error saving ${filePath}:`, err);
  }
}

let routesData = loadJSON(ROUTES_FILE).filter((r) => r && r.routeName);
let batchesData = loadJSON(BATCHES_FILE).filter((b) => b && b.batchName);

saveJSON(ROUTES_FILE, routesData);
saveJSON(BATCHES_FILE, batchesData);

app.get("/", (req, res) => {
  res.redirect("/admin");
});

// Admin Dashboard
app.get("/admin", (req, res) => {
  const totalEmployees = routesData.reduce(
    (acc, r) => acc + (parseInt(r.headcount, 10) || 0),
    0,
  );
  res.render("admin", {
    routes: routesData,
    batches: batchesData,
    totalEmployees,
  });
});

// Live JSON API for background Admin sync
app.get("/api/routes", (req, res) => {
  const totalEmployees = routesData.reduce(
    (acc, r) => acc + (parseInt(r.headcount, 10) || 0),
    0,
  );
  res.json({
    routes: routesData,
    batches: batchesData,
    totalEmployees,
  });
});

// Admin: Create New Batch / Shift
app.post("/admin/add-batch", (req, res) => {
  const { batchName, shiftTime, shiftType } = req.body;
  if (!batchName || !shiftTime) {
    return res.redirect("/admin");
  }

  const newBatch = {
    id: "batch-" + Date.now(),
    batchName: batchName.trim(),
    shiftTime: shiftTime.trim(),
    shiftType: (shiftType || "Regular").trim(),
  };

  batchesData.push(newBatch);
  saveJSON(BATCHES_FILE, batchesData);
  res.redirect("/admin");
});

// Admin: Delete Batch
app.post("/admin/delete-batch/:id", (req, res) => {
  batchesData = batchesData.filter((b) => b.id !== req.params.id);
  saveJSON(BATCHES_FILE, batchesData);
  res.redirect("/admin");
});

// Admin: Add New Route / Vehicle
app.post("/admin/add-route", (req, res) => {
  const {
    routeName,
    vehicleNo,
    vehicleType,
    capacity,
    driverName,
    contactNo,
    batch,
    driverPin,
  } = req.body;

  if (!routeName || !vehicleNo || !driverName || !driverPin) {
    return res.redirect("/admin");
  }

  const newRoute = {
    id: "route-" + Date.now(),
    routeName: routeName.trim(),
    vehicleNo: vehicleNo.trim().toUpperCase(),
    vehicleType: vehicleType || "Bus",
    capacity: parseInt(capacity, 10) || 40,
    driverName: driverName.trim(),
    contactNo: (contactNo || "").trim(),
    batch: (batch || "General Shift").trim(),
    driverPin: driverPin.trim(),
    headcount: 0,
    tripStatus: "Yet to Start",
    isLocked: false,
    lastUpdated: "Never",
  };

  routesData.push(newRoute);
  saveJSON(ROUTES_FILE, routesData);
  res.redirect("/admin");
});

// Admin: Unlock a Driver's Route (in case driver locked by mistake)
app.post("/admin/unlock-route/:id", (req, res) => {
  const route = routesData.find((r) => r.id === req.params.id);
  if (route) {
    route.isLocked = false;
    route.tripStatus = "En Route";
    saveJSON(ROUTES_FILE, routesData);
  }
  res.redirect("/admin");
});

// Admin: Delete Single Route
app.post("/admin/delete-route/:id", (req, res) => {
  routesData = routesData.filter((r) => r.id !== req.params.id);
  saveJSON(ROUTES_FILE, routesData);
  res.redirect("/admin");
});

// Admin: Reset Shift Counts (Resets counts to 0 and unlocks all drivers)
app.post("/admin/reset", (req, res) => {
  routesData = routesData.map((r) => ({
    ...r,
    headcount: 0,
    tripStatus: "Yet to Start",
    isLocked: false,
    lastUpdated: "Never",
  }));
  saveJSON(ROUTES_FILE, routesData);
  res.redirect("/admin");
});

// Admin: Clear All Routes
app.post("/admin/clear-all", (req, res) => {
  routesData = [];
  saveJSON(ROUTES_FILE, routesData);
  res.redirect("/admin");
});

// Driver Login Page
app.get("/driver/login", (req, res) => {
  res.render("driver-login", { routes: routesData, error: null });
});

// Driver Authentication & Portal Entry
app.post("/driver/portal", (req, res) => {
  const { routeId, pin } = req.body;
  const route = routesData.find((r) => r.id === routeId);

  if (!route || route.driverPin !== (pin || "").trim()) {
    return res.render("driver-login", {
      routes: routesData,
      error: "Invalid 4-Digit PIN or Route selected.",
    });
  }

  res.render("driver", { route });
});

// Driver Update Headcount & Lock Endpoint
app.post("/driver/update", (req, res) => {
  const { routeId, headcount, tripStatus, lockSubmission } = req.body;
  const route = routesData.find((r) => r.id === routeId);

  if (!route) {
    return res.status(404).json({ success: false, message: "Route not found" });
  }

  // Block any changes if route is already locked
  if (route.isLocked) {
    return res.status(403).json({
      success: false,
      isLocked: true,
      message:
        "Headcount is already submitted and locked! Contact Admin to unlock.",
    });
  }

  route.headcount = Math.max(0, parseInt(headcount, 10) || 0);

  if (lockSubmission) {
    route.tripStatus = "Arrived at Plant";
    route.isLocked = true;
  } else if (tripStatus) {
    route.tripStatus = tripStatus;
  } else if (route.headcount > 0 && route.tripStatus === "Yet to Start") {
    route.tripStatus = "En Route";
  }

  route.lastUpdated = new Date().toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  saveJSON(ROUTES_FILE, routesData);

  res.json({
    success: true,
    headcount: route.headcount,
    tripStatus: route.tripStatus,
    isLocked: route.isLocked,
    lastUpdated: route.lastUpdated,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`Vikram Solar Fleet Tracker Live!`);
  console.log(`Admin Portal  : http://localhost:${PORT}/admin`);
  console.log(`Driver Portal : http://localhost:${PORT}/driver/login`);
  console.log(`====================================================`);
});
