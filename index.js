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
    origin: "http://localhost:5173", // ✅ exact frontend URL
    credentials: true, // ✅ allow cookies
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
    const registeredCollections = db.collection("registered");

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
    app.get("/contest-is-registered", async (req, res) => {
      const { contestId, email } = req.query;
      console.log(contestId, email);

      const registered = await registeredCollections.findOne({
        contestId,
        customer_email: email,
      });

      res.send({ registered: !!registered });
      // res.send({ msg: "is registerd" });
    });
    app.get("/registered", async (req, res) => {
      const { email } = req.query;
      const query = { customer_email: email };
      const registered = registeredCollections.find(query).sort({deadline: 1})
      const result = await registered.toArray();
      res.send(result);
      console.log(req.query,result);
      
    });
    app.post("/contest/payment-register", async (req, res) => {
      const registerInf = req.body;
      console.log(registerInf);

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
        customer_email: registerInf.userEmail,
        metadata: {
          contestId: registerInf.contestId,
          contestName: registerInf.contestName,
          participantsCount: registerInf.participantsCount,
          customer_email: registerInf.userEmail,
          deadline: registerInf.deadline,
        },
      });
      res.send({ url: session.url });
    });

    app.post("/contest/free-register", async (req, res) => {
      const { contestId, contestName, userEmail, deadline } = req.body;

      const alreadyRegistered = await registeredCollections.findOne({
        contestId,
        customer_email: userEmail,
      });

      if (alreadyRegistered) {
        return res.send({ message: "Already registered" });
      }

      await contestCollections.updateOne(
        { _id: new ObjectId(contestId) },
        { $inc: { participantsCount: 1 } }
      );

      const registerInfo = {
        contestId,
        contestName,
        customer_email: userEmail,
        paymentStatus: "free",
        registeredAt: new Date(),
        deadline,
      };

      await registeredCollections.insertOne(registerInfo);

      res.send({ success: true });
    });

    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      // prevent double posting payment_history
      const transactionId = session.payment_intent;
      const query = { transactionId: transactionId };

      const paymentExist = await registeredCollections.findOne(query);
      // console.log(paymentExist);

      if (paymentExist) {
        return res.send({
          message: "Already exist",
          transactionId,
          paymentInfo: paymentExist,
        });
      }

      if (session.payment_status === "paid") {
        const contestId = session.metadata.contestId;
        const query = { _id: new ObjectId(contestId) };
        const updateContestItem = {
          $inc: { participantsCount: 1 },
          // $addToSet: { participants: userId }, // prevents duplicate registration
        };
        const options = {};
        const result = await contestCollections.updateOne(
          query,
          updateContestItem,
          options
        );
        const paymentHistory = {
          amount: session.amount_total / 100,
          contestName: session.metadata.contestName,
          customer_email: session.metadata.customer_email,
          contestId: session.metadata.contestId,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          deadline: session.metadata.deadline,
        };
        const registeredResult = await registeredCollections.insertOne(
          paymentHistory
        );
        return res.send({
          success: true,
          modifyContest: result,
          paymentInfo: paymentHistory,
          registeredResult: registeredResult,
          transactionId: session.payment_intent,
        });
      }
      return res.send({ message: false });
    });

    // users api
    app.post("/users", async (req, res) => {
      try {
        const user = req.body;
        user.role = "user";
        user.createdAt = new Date();

        const query = { email: user.email };
        const userExist = await usersCollections.findOne(query);

        if (userExist) {
          return res.status(409).json({ message: "user already exist" });
        }

        const result = await usersCollections.insertOne(user);

        return res.status(201).json({
          insertedId: result.insertedId,
          message: "User created",
        });
      } catch (error) {
        return res.status(500).json({ message: "Internal server error" });
      }
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
