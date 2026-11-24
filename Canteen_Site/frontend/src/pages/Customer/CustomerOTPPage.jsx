import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import '../../styles/login.css'; // Using the same CSS file
import axios from 'axios';
import { FaHorseHead } from 'react-icons/fa';

axios.defaults.withCredentials = true;

const showNotification = (message, type = 'success') => {
    const notification = document.createElement('div');
    notification.className = `cp-notification cp-${type}`;
    notification.textContent = message;
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.style.opacity = '0';
        setTimeout(() => {
            document.body.removeChild(notification);
        }, 500);
    }, 3000);
};


// const bcrypt = require('bcrypt');
const OtpPage = () => {
    const navigate = useNavigate();
    const [otp, setOtp] = useState('');

    const handleSubmit = async (e) => {
        e.preventDefault();

        // Validate OTP
        if (!otp || otp.length !== 6) {
            showNotification('Please enter a valid 6-digit OTP', "error");
            return;
        }

        // The code is checked on the SERVER. The browser never sees the OTP or its hash.
        const email = sessionStorage.getItem("email");
        if (!email) {
            showNotification("Sign-up session expired. Please sign up again.", "error");
            navigate("/signup");
            return;
        }

        try {
            await axios.post("http://localhost:4000/auth/verify-otp", { email, otp });
            showNotification("Account Created Successfully!", "success");
            sessionStorage.clear();
            navigate("/login");
        } catch (error) {
            const status = error.response && error.response.status;
            const message = (error.response && error.response.data && error.response.data.message) || "Server error. Please try again later.";
            showNotification(message, "error");
            // Expired, too many attempts, or no pending sign-up: start again.
            if (status === 404 || status === 410 || status === 429) {
                sessionStorage.clear();
                navigate("/signup");
            }
        }
    };

    return (
        <div className="container">
            <div className="background-image"></div>
            <div className="signup-container">
                <div className="logo-container">
                    <img src="/images/logo.png" alt="Quick Crave Logo" className="logo-image" />
                    <h1 className="logo-text">
                        <span className="red-text">Quick</span> <span className="yellow-text">Crave</span>
                    </h1>
                </div>
                <div className="signup-form">
                    <h3>Verify Your Account</h3>
                    <form id="otp-form" onSubmit={handleSubmit}>
                        <div className="form-group">
                            <input
                                type="text"
                                id="otp"
                                placeholder="Enter 6-digit OTP..."
                                value={otp}
                                onChange={(e) => setOtp(e.target.value)}
                                maxLength="6"
                                required
                            />
                        </div>
                        <button type="submit" className="signup-btn">
                            Verify OTP
                        </button>
                    </form>
                    <div className="form-footer">
                        <p>
                            Didn't receive OTP? <Link to="/resend-otp" className="form-link"> Resend OTP</Link>
                        </p>
                        <p>
                            <Link to="/signup" className="form-link">Back to Signup</Link>
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default OtpPage;
