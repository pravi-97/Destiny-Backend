require('dotenv').config();
const AWS_ACCESS_KEY = process.env.AWS_ACCESS_KEY;
const AWS_SECRET_KEY = process.env.AWS_SECRET_KEY;
const AWS_REGION = process.env.AWS_REGION;
const MODEL_NAME = process.env.MODEL_NAME;
const PALM_API_KEY = process.env.PALM_API_KEY;
const AWS = require('aws-sdk');
const multer = require('multer');
const express = require('express');
const cors = require('cors');
const axios = require('axios')
const { TextServiceClient } = require("@google-ai/generativelanguage").v1beta2;
const { GoogleAuth } = require("google-auth-library");
const app = express();
const bodyParser = require('body-parser');
const upload = multer();
let timestamp;
AWS.config.update({
    accessKeyId: AWS_ACCESS_KEY, 
    secretAccessKey: AWS_SECRET_KEY, 
    region: AWS_REGION
});
const googleClient = new TextServiceClient({
    authClient: new GoogleAuth().fromAPIKey(PALM_API_KEY),
});
const transcribeService = new AWS.TranscribeService();
const pollyClient = new AWS.Polly();
// Function to wait for the transcription job to complete and print the results
async function waitForTranscriptionJob(jobName, res) {
    const params = { TranscriptionJobName: jobName };

    try {
        const response = await transcribeService.getTranscriptionJob(params).promise();
        const jobStatus = response.TranscriptionJob.TranscriptionJobStatus;

        if (jobStatus === 'COMPLETED') {
            const transcriptionUrl = response.TranscriptionJob.Transcript.TranscriptFileUri;

            // Fetch and print the transcription results
            const transcription = await fetchTranscriptionResult(transcriptionUrl);
            console.log('Transcription result:', transcription);
            runPalm(transcription, res);
            // res.status(200).json({ success: transcription });
        } else if (jobStatus === 'FAILED' || jobStatus === 'STOPPED') {
            console.error('Transcription job failed or stopped.');
            res.status(500).json({ error: 'Transcription job failed or stopped.' });
        } else {
            // If the job is still in progress, wait for a few seconds and check again
            setTimeout(() => waitForTranscriptionJob(jobName, res), 5000);
        }
    } catch (err) {
        console.error('Error fetching transcription job status:', err);
        res.status(500).json({ error: 'Error fetching transcription job status' });
    }
}

// Function to fetch and parse the transcription results from the given URL
async function fetchTranscriptionResult(url) {
    try {
        const response = await axios.get(url);
        return response.data.results.transcripts[0].transcript;
    } catch (err) {
        console.error('Error fetching transcription results:', err);
        return null;
    }
}
async function runPalm(prompt, res) {
    googleClient.generateText({
        model: MODEL_NAME,
        prompt: {
            text: prompt,
        },
    })
        .then((result) => {
            // console.log(JSON.stringify(result[0].candidates[0].output));
            let toPolly = JSON.stringify(result[0].candidates[0].output)
            toPolly = toPolly.replace(/\\n/g, "");
            toPolly = toPolly.replace(/\\r/g, "");
            toPolly = toPolly.replace(/\\t/g, "");
            // toPolly = toPolly.replace("*/g", "");
            runPolly(toPolly, res)
        });
}
async function runPolly(textToSpeak, res) {
    console.log("textToSpeak: ", textToSpeak);
    const params = {
        OutputFormat: 'mp3',
        SampleRate: '16000',
        Text: textToSpeak,
        VoiceId: 'Ruth', 
        Engine: 'neural',
    };

    try {
        const response = await pollyClient.synthesizeSpeech(params).promise();
        res.setHeader('Content-Type', 'audio/mpeg');
        res.send(response.AudioStream);
    } catch (err) {
        console.error('Error synthesizing speech:', err);
        res.sendStatus(500);
    }
}

// Function to start the transcription job
async function startTranscriptionJob(res) {
    const params = {
        TranscriptionJobName: `${timestamp}-destiny-test-job`, 
        LanguageCode: 'en-US', 
        Media: {
            MediaFileUri: `s3://praveesh-project-destiny/${timestamp}-audio.webm`, 
        },
    };

    try {
        const response = await transcribeService.startTranscriptionJob(params).promise();
        console.log('Transcription job started:', response.TranscriptionJob.TranscriptionJobName);

        await waitForTranscriptionJob(response.TranscriptionJob.TranscriptionJobName, res);
    } catch (err) {
        console.error('Error starting transcription job:', err);
        res.status(500).json({ error: 'Error starting transcription job' });
    }
}

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));


app.post('/transcribe', upload.single('audioData'), async (req, res) => {
    timestamp = Date.now();
    const fileBuf = req.file.buffer;

    const bucketName = 'praveesh-project-destiny'; 
    const objectKey = `${timestamp}-audio.webm`;

    try {
        const response = await uploadToS3(fileBuf, bucketName, objectKey);
        const uploadedETag = response.ETag;

        console.log('File uploaded successfully.');
        console.log('ETag value:', uploadedETag);
        startTranscriptionJob(res);

    } catch (error) {
        console.error('Error uploading file:', error);
        res.status(500).json({ error: 'Error uploading file' });
    }
});

// Function to upload the file to S3
async function uploadToS3(file, bucketName, objectKey) {
    const s3 = new AWS.S3();

    // Set up the parameters for the S3 object
    const params = {
        Bucket: bucketName,
        Key: objectKey,
        Body: file
    };

    return s3.putObject(params).promise();
}

const port = 3001;
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
