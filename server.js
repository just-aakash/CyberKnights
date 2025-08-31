// server.js

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer'); // for photo uploads
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = 'your_jwt_secret_here'; // use env var in prod

// Connect to MongoDB (local or cloud)
mongoose.connect('mongodb://localhost:27017/attendanceDB', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('MongoDB connected'))
.catch(err => console.error('MongoDB connection error:', err));

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Multer config for storing photos
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './uploads/students';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    // Save with timestamp + original name
    const ext = path.extname(file.originalname);
    cb(null, file.fieldname + '-' + Date.now() + ext);
  }
});
const upload = multer({ storage });

// Schemas & Models

const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  passwordHash: String,
});

const StudentSchema = new mongoose.Schema({
  rollNo: { type: String, unique: true },
  name: String,
  photos: [String], // paths to photos
});

const LectureSchema = new mongoose.Schema({
  name: String,
  roomNo: String,
  section: String,
});

const AttendanceSchema = new mongoose.Schema({
  lecture: { type: mongoose.Schema.Types.ObjectId, ref: 'Lecture' },
  date: { type: Date, default: Date.now },
  studentsPresent: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Student' }],
});

const User = mongoose.model('User', UserSchema);
const Student = mongoose.model('Student', StudentSchema);
const Lecture = mongoose.model('Lecture', LectureSchema);
const Attendance = mongoose.model('Attendance', AttendanceSchema);

// Seed demo user if not exist
(async () => {
  const user = await User.findOne({ username: 'Akash' });
  if (!user) {
    const passwordHash = await bcrypt.hash('12345', 10);
    await User.create({ username: 'Akash', passwordHash });
    console.log('Demo user created');
  }
})();

// Authentication Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// Routes

// Login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username });
  if (!user) return res.status(400).json({ message: 'Invalid username or password' });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(400).json({ message: 'Invalid username or password' });

  // Generate JWT token
  const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token });
});

// Change Password
app.post('/api/change-password', authenticateToken, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = await User.findOne({ username: req.user.username });
  if (!user) return res.status(404).json({ message: 'User not found' });

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) return res.status(400).json({ message: 'Current password incorrect' });

  user.passwordHash = await bcrypt.hash(newPassword, 10);
  await user.save();
  res.json({ message: 'Password changed successfully' });
});

// Register new student with photos (2 photos required)
app.post('/api/students', authenticateToken, upload.array('photos', 2), async (req, res) => {
  const { rollNo, name } = req.body;
  if (!rollNo || !name) return res.status(400).json({ message: 'Roll No and Name are required' });
  if (!req.files || req.files.length !== 2) return res.status(400).json({ message: 'Two photos required' });

  try {
    const photos = req.files.map(file => `/uploads/students/${file.filename}`);

    const existingStudent = await Student.findOne({ rollNo });
    if (existingStudent) return res.status(400).json({ message: 'Student with this roll no already exists' });

    const student = new Student({ rollNo, name, photos });
    await student.save();
    res.json({ message: 'Student registered', student });
  } catch (err) {
    res.status(500).json({ message: 'Error registering student', error: err.message });
  }
});

// Get all students
app.get('/api/students', authenticateToken, async (req, res) => {
  const students = await Student.find();
  res.json(students);
});

// Get lectures (static demo for now)
app.get('/api/lectures', authenticateToken, async (req, res) => {
  // Could be from DB or static list
  let lectures = await Lecture.find();
  if (lectures.length === 0) {
    // Seed some lectures if none exist
    lectures = await Lecture.insertMany([
      { name: 'Discrete Mathematics', roomNo: 'CS2005', section: '2FA' },
      { name: 'Computer Organisation', roomNo: 'BSCS100', section: '2AA' },
      { name: 'DBMS', roomNo: 'BCO1005', section: '2CA' },
      { name: 'English', roomNo: 'BELH 0081', section: '2XX' },
      { name: 'HTML', roomNo: 'PCPH0001', section: '2XN' },
    ]);
  }
  res.json(lectures);
});

// Get attendance for a lecture and date (date optional, defaults today)
app.get('/api/attendance/:lectureId', authenticateToken, async (req, res) => {
  const { lectureId } = req.params;
  const date = req.query.date ? new Date(req.query.date) : new Date();
  const start = new Date(date.setHours(0, 0, 0, 0));
  const end = new Date(date.setHours(23, 59, 59, 999));

  const attendance = await Attendance.findOne({
    lecture: lectureId,
    date: { $gte: start, $lte: end },
  }).populate('studentsPresent');

  res.json(attendance || { lecture: lectureId, date: start, studentsPresent: [] });
});

// Mark attendance manually (add student to attendance)
app.post('/api/attendance/mark', authenticateToken, async (req, res) => {
  const { lectureId, studentId, date } = req.body;
  if (!lectureId || !studentId) return res.status(400).json({ message: 'lectureId and studentId required' });

  const attendanceDate = date ? new Date(date) : new Date();
  const start = new Date(attendanceDate.setHours(0, 0, 0, 0));
  const end = new Date(attendanceDate.setHours(23, 59, 59, 999));

  let attendance = await Attendance.findOne({
    lecture: lectureId,
    date: { $gte: start, $lte: end },
  });

  if (!attendance) {
    attendance = new Attendance({
      lecture: lectureId,
      date: start,
      studentsPresent: [],
    });
  }

  if (!attendance.studentsPresent.includes(studentId)) {
    attendance.studentsPresent.push(studentId);
    await attendance.save();
    res.json({ message: 'Attendance marked', attendance });
  } else {
    res.status(400).json({ message: 'Student already marked present' });
  }
});

// Server start
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const form = document.getElementById("loginForm");
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = document.getElementById("username").value;
  const password = document.getElementById("password").value;

  try {
    const response = await fetch("http://your-backend-domain.com/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await response.json();

    if (response.ok) {
      // Successful login
      window.location.href = "home.html";
    } else {
      alert(data.message || "Login failed");
    }
  } catch (error) {
    alert("Error connecting to backend: " + error.message);
  }
});