

const express = require('express');
const app = express();
const PORT = process.env.PORT || 1000;
app.get('/api/health', (req, res) => res.send('ok'));
app.listen(PORT, () => console.log('Listening on', PORT));
