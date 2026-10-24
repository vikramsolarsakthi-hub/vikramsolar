const express = require("express");
const path = require("path");
const admin = require("firebase-admin");
const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Initialize Firebase Admin SDK using your serviceAccountKey.json
const serviceAccount = require("./serviceAccountKey.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// Helper functions for Firestore collections
async function getRoutes() {
  const snapshot = await db.collection("routes").get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

async function getBatches() {
  const snapshot = await db.collection("batches").get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

app.get("/", (req, res) => {
  res.redirect("/admin");
});

// Admin Dashboard
app.get("/admin", async (req, res) => {
  try {
    const routesData = await getRoutes();
    const batchesData = await getBatches();
    const totalEmployees = routesData.reduce(
      (acc, r) => acc + (parseInt(r.headcount, 10) || 0),
      0,
    );
    res.render("admin", {
      routes: routesData,
      batches: batchesData,
      totalEmployees,
    });
  } catch (err) {
    console.error("Error loading admin dashboard:", err);
    res.status(500).send("Database error loading admin dashboard.");
  }
});

// Live JSON API for background Admin sync
app.get("/api/routes", async (req, res) => {
  try {
    const routesData = await getRoutes();
    const batchesData = await getBatches();
    const totalEmployees = routesData.reduce(
      (acc, r) => acc + (parseInt(r.headcount, 10) || 0),
      0,
    );
    res.json({
      routes: routesData,
      batches: batchesData,
      totalEmployees,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch routes" });
  }
});

// Admin: Create New Batch / Shift
app.post("/admin/add-batch", async (req, res) => {
  const { batchName, shiftTime, shiftType } = req.body;
  if (!batchName || !shiftTime) return res.redirect("/admin");

  try {
    await db.collection("batches").add({
      batchName: batchName.trim(),
      shiftTime: shiftTime.trim(),
      shiftType: (shiftType || "Regular").trim(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error("Error adding batch:", err);
  }
  res.redirect("/admin");
});

// Admin: Delete Batch
app.post("/admin/delete-batch/:id", async (req, res) => {
  try {
    await db.collection("batches").doc(req.params.id).delete();
  } catch (err) {
    console.error("Error deleting batch:", err);
  }
  res.redirect("/admin");
});

// Admin: Add New Route / Vehicle
app.post("/admin/add-route", async (req, res) => {
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

  try {
    await db.collection("routes").add({
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
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error("Error adding route:", err);
  }
  res.redirect("/admin");
});

// Admin: Unlock a Driver's Route
app.post("/admin/unlock-route/:id", async (req, res) => {
  try {
    await db.collection("routes").doc(req.params.id).update({
      isLocked: false,
      tripStatus: "En Route",
    });
  } catch (err) {
    console.error("Error unlocking route:", err);
  }
  res.redirect("/admin");
});

// Admin: Delete Single Route
app.post("/admin/delete-route/:id", async (req, res) => {
  try {
    await db.collection("routes").doc(req.params.id).delete();
  } catch (err) {
    console.error("Error deleting route:", err);
  }
  res.redirect("/admin");
});

// Admin: Reset Shift Counts
app.post("/admin/reset", async (req, res) => {
  try {
    const snapshot = await db.collection("routes").get();
    const batchOps = snapshot.docs.map((doc) =>
      doc.ref.update({
        headcount: 0,
        tripStatus: "Yet to Start",
        isLocked: false,
        lastUpdated: "Never",
      }),
    );
    await Promise.all(batchOps);
  } catch (err) {
    console.error("Error resetting routes:", err);
  }
  res.redirect("/admin");
});

// Admin: Clear All Routes
app.post("/admin/clear-all", async (req, res) => {
  try {
    const snapshot = await db.collection("routes").get();
    const batchOps = snapshot.docs.map((doc) => doc.ref.delete());
    await Promise.all(batchOps);
  } catch (err) {
    console.error("Error clearing routes:", err);
  }
  res.redirect("/admin");
});

// Driver Login Page
app.get("/driver/login", async (req, res) => {
  try {
    const routesData = await getRoutes();
    res.render("driver-login", { routes: routesData, error: null });
  } catch (err) {
    res.status(500).send("Database error.");
  }
});

// Driver Authentication & Portal Entry
app.post("/driver/portal", async (req, res) => {
  try {
    const routesData = await getRoutes();
    const { routeId, pin } = req.body;
    const route = routesData.find((r) => r.id === routeId);

    if (!route || route.driverPin !== (pin || "").trim()) {
      return res.render("driver-login", {
        routes: routesData,
        error: "Invalid 4-Digit PIN or Route selected.",
      });
    }

    res.render("driver", { route });
  } catch (err) {
    res.status(500).send("Portal error.");
  }
});

// Driver Update Headcount & Lock Endpoint with Date History
app.post("/driver/update", async (req, res) => {
  const { routeId, headcount, tripStatus, lockSubmission } = req.body;

  try {
    const routeRef = db.collection("routes").doc(routeId);
    const doc = await routeRef.get();

    if (!doc.exists) {
      return res
        .status(404)
        .json({ success: false, message: "Route not found" });
    }

    const route = doc.data();

    if (route.isLocked) {
      return res.status(403).json({
        success: false,
        isLocked: true,
        message:
          "Headcount is already submitted and locked! Contact Admin to unlock.",
      });
    }

    const newHeadcount = Math.max(0, parseInt(headcount, 10) || 0);
    const currentDate = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD
    const currentTime = new Date().toLocaleTimeString("en-IN", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    let newStatus = route.tripStatus;
    let isLocked = route.isLocked;

    if (lockSubmission) {
      newStatus = "Arrived at Plant";
      isLocked = true;

      // Save to history collection for date-wise viewing
      await db.collection("history").add({
        date: currentDate,
        routeId: routeId,
        routeName: route.routeName,
        vehicleNo: route.vehicleNo,
        driverName: route.driverName,
        batch: route.batch,
        headcount: newHeadcount,
        submittedAt: currentTime,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else if (tripStatus) {
      newStatus = tripStatus;
    } else if (newHeadcount > 0 && newStatus === "Yet to Start") {
      newStatus = "En Route";
    }

    await routeRef.update({
      headcount: newHeadcount,
      tripStatus: newStatus,
      isLocked: isLocked,
      lastUpdated: currentTime,
      tripDate: currentDate,
    });

    res.json({
      success: true,
      headcount: newHeadcount,
      tripStatus: newStatus,
      isLocked: isLocked,
      lastUpdated: currentTime,
    });
  } catch (err) {
    console.error("Error updating route:", err);
    res
      .status(500)
      .json({ success: false, message: "Server error updating route" });
  }
});

// API to fetch historical logs date-wise
app.get("/api/history", async (req, res) => {
  try {
    const selectedDate =
      req.query.date || new Date().toLocaleDateString("en-CA");
    const snapshot = await db
      .collection("history")
      .where("date", "==", selectedDate)
      .get();

    const logs = snapshot.docs.map((doc) => doc.data());
    const total = logs.reduce(
      (acc, h) => acc + (parseInt(h.headcount, 10) || 0),
      0,
    );

    res.json({ date: selectedDate, logs, totalEmployees: total });
  } catch (err) {
    console.error("Error fetching history:", err);
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

// Local server startup
const PORT = process.env.PORT || 3000;
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(
      `Vikram Solar Fleet Tracker Live on http://localhost:${PORT}/admin`,
    );
  });
}

// Export Express app for Vercel Serverless
module.exports = app;
