import express from "express";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const WORKFLOW_ID = process.env.OPENAI_WORKFLOW_ID;

app.post("/api/chatkit/session", async (req, res) => {
  try {

    const session = await openai.chatkit.sessions.create({
      workflow: { id: WORKFLOW_ID }
    });

    res.json({
      client_secret: session.client_secret
    });

  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

app.get("/", (req,res)=>{
  res.send("OpenAI Proxy Running");
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log("Server running on port", port);
});