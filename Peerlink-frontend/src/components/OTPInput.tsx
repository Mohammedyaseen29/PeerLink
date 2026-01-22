import React, { useRef, useState, useEffect } from 'react';
import { motion } from 'framer-motion';

interface OTPInputProps {
    length?: number;
    value: string;
    onChange: (value: string) => void;
    onComplete?: (value: string) => void;
}

const OTPInput: React.FC<OTPInputProps> = ({
    length = 6,
    value,
    onChange,
    onComplete,
}) => {
    const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
    const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

    // Split value into array of characters
    const valueArray = value.split('').slice(0, length);
    while (valueArray.length < length) {
        valueArray.push('');
    }

    useEffect(() => {
        // Focus first input on mount
        inputRefs.current[0]?.focus();
    }, []);

    useEffect(() => {
        if (value.length === length && onComplete) {
            onComplete(value);
        }
    }, [value, length, onComplete]);

    const handleChange = (index: number, inputValue: string) => {
        const char = inputValue.slice(-1).toUpperCase();

        if (!/^[A-Z0-9]?$/.test(char)) return;

        const newValue = valueArray.slice();
        newValue[index] = char;
        const newString = newValue.join('');
        onChange(newString);

        // Move to next input
        if (char && index < length - 1) {
            inputRefs.current[index + 1]?.focus();
        }
    };

    const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Backspace') {
            if (!valueArray[index] && index > 0) {
                inputRefs.current[index - 1]?.focus();
                const newValue = valueArray.slice();
                newValue[index - 1] = '';
                onChange(newValue.join(''));
            } else {
                const newValue = valueArray.slice();
                newValue[index] = '';
                onChange(newValue.join(''));
            }
        } else if (e.key === 'ArrowLeft' && index > 0) {
            inputRefs.current[index - 1]?.focus();
        } else if (e.key === 'ArrowRight' && index < length - 1) {
            inputRefs.current[index + 1]?.focus();
        }
    };

    const handlePaste = (e: React.ClipboardEvent) => {
        e.preventDefault();
        const pastedData = e.clipboardData.getData('text').toUpperCase().replace(/[^A-Z0-9]/g, '');
        const newValue = pastedData.slice(0, length);
        onChange(newValue);

        // Focus the appropriate input
        const focusIndex = Math.min(newValue.length, length - 1);
        inputRefs.current[focusIndex]?.focus();
    };

    return (
        <div className="otp-container">
            {valueArray.map((char, index) => (
                <motion.input
                    key={index}
                    ref={(el) => {
                        inputRefs.current[index] = el;
                    }}
                    type="text"
                    inputMode="text"
                    maxLength={1}
                    value={char}
                    onChange={(e) => handleChange(index, e.target.value)}
                    onKeyDown={(e) => handleKeyDown(index, e)}
                    onPaste={handlePaste}
                    onFocus={() => setFocusedIndex(index)}
                    onBlur={() => setFocusedIndex(null)}
                    className="otp-input"
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{
                        scale: 1,
                        opacity: 1,
                        borderColor: focusedIndex === index ? '#00d4ff' : 'rgba(255,255,255,0.1)'
                    }}
                    transition={{ delay: index * 0.05, duration: 0.2 }}
                    whileFocus={{ scale: 1.05 }}
                />
            ))}
        </div>
    );
};

export default OTPInput;
