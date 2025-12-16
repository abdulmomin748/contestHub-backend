require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const port = process.env.PORT || 3000;
// const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString(
//   'utf-8'
// )
// const serviceAccount = JSON.parse(decoded)
// admin.initializeApp({
//   credential: admin.credential.cert(serviceAccount),
// })
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const YOUR_DOMAIN = `http://localhost:5173`;
const app = express();
// middleware
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:5174",
      "https://b12-m11-session.web.app",
    ],
    credentials: true,
    optionSuccessStatus: 200,
  })
);
app.use(express.json());

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    console.log(decoded);
    next();
  } catch (err) {
    console.log(err);
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.yxa7hqd.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("contestHub_db");
    const contestCollections = db.collection("contests");

    // contest api
    app.get("/contests", async (req, res) => {
      const query = {};
      const contests = contestCollections
        .find(query)
        .sort({ participantsCount: -1 })
        .limit(5);
      const cursor = await contests.toArray();
      res.send(cursor);
    });
    app.get("/contest/:id", async (req, res) => {
      const { id } = req.params;
      const query = { _id: new ObjectId(id) };
      const result = await contestCollections.findOne(query);
      res.send(result);
    });

    // register api
    app.post("/contest/payment-register", async (req, res) => {
      const registerInf = req.body;

      const amount = parseInt(registerInf.registrationFee) * 100; // 1tk =100 poisa
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            // Provide the exact Price ID (for example, price_1234) of the product you want to sell
            price_data: {
              unit_amount: amount,
              currency: "usd",
              product_data: {
                name: registerInf.contestName,
              },
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        success_url: `${YOUR_DOMAIN}/contest/${registerInf.contestId}?session_id={CHECKOUT_SESSION_ID}`,
        // cancel_url: `${YOUR_DOMAIN}/dashBoard/payment-cancelled?session_id={CHECKOUT_SESSION_ID}`,
        // set hoina
        metadata: {
          contestId: registerInf.contestId,
          contestName: registerInf.contestName,
        },
      });
      res.send({ url: session.url });
    });
    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      // use the previous trackingId created during parcel  create which was set to the session metadata during session createtion
      const trackingId = session.metadata.trackingId;

      // prevent double posting payment_history
      const transactionId = session.payment_intent;
      const query = { transactionId: transactionId };

      const paymentExist = await paymentCollectins.findOne(query);
      // console.log(paymentExist);

      if (paymentExist) {
        return res.send({
          message: "Already exist",
          transactionId,
          trackingId: paymentExist.trackingId,
          paymentInfo: paymentExist,
        });
      }

      if (session.payment_status === "paid") {
        const parcelId = session.metadata.parcelId;
        const query = { _id: new ObjectId(parcelId) };
        const updatePItm = {
          $set: {
            paymentSatus: "paid",
            deliveryStatus: "parcel_paid",
          },
        };
        const options = {};
        const result = await parcelCollections.updateOne(
          query,
          updatePItm,
          options
        );
        const paymentHistory = {
          amount: session.amount_total / 100,
          currency: session.currency,
          percelName: session.metadata.percelName,
          customeremail: session.customer_email,
          parcelId: session.metadata.parcelId,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          trackingId: trackingId,
          paidAt: new Date(),
        };

        logTracking(trackingId, "parcel_paid");

        const payementInsetResult = await paymentCollectins.insertOne(
          paymentHistory
        );
        return res.send({
          success: true,
          modifyPercel: result,
          paymentInfo: paymentHistory,
          trackingId: trackingId,
          transactionId: session.payment_intent,
        });
      }
      return res.send({ message: false });
    });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello from Server..");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
