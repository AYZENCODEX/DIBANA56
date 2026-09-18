import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle, Star, Zap } from "lucide-react";

interface Particle {
  id: number;
  x: number;
  y: number;
  color: string;
  size: number;
  angle: number;
  distance: number;
}

const COLORS = ["#00d4cc", "#00ff9d", "#7c3aed", "#f59e0b", "#ec4899", "#3b82f6"];

function createParticles(count = 24): Particle[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    x: 50,
    y: 50,
    color: COLORS[i % COLORS.length],
    size: Math.random() * 6 + 3,
    angle: (i / count) * 360,
    distance: Math.random() * 120 + 60,
  }));
}

interface SuccessAnimationProps {
  show: boolean;
  onDone?: () => void;
  message?: string;
  subMessage?: string;
  type?: "success" | "task" | "login";
}

export function SuccessAnimation({ show, onDone, message = "Success!", subMessage, type = "success" }: SuccessAnimationProps) {
  const [particles] = useState(() => createParticles(28));

  useEffect(() => {
    if (show && onDone) {
      const t = setTimeout(onDone, 2000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [show, onDone]);

  const Icon = type === "task" ? Star : type === "login" ? Zap : CheckCircle;
  const iconColor = type === "task" ? "#f59e0b" : type === "login" ? "#7c3aed" : "#00d4cc";

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={onDone}
        >
          <div className="relative flex items-center justify-center w-48 h-48">
            {/* Particles */}
            {particles.map(p => (
              <motion.div
                key={p.id}
                className="absolute rounded-full"
                style={{
                  width: p.size,
                  height: p.size,
                  backgroundColor: p.color,
                  left: "50%",
                  top: "50%",
                  marginLeft: -p.size / 2,
                  marginTop: -p.size / 2,
                  boxShadow: `0 0 ${p.size * 2}px ${p.color}80`,
                }}
                initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
                animate={{
                  x: Math.cos((p.angle * Math.PI) / 180) * p.distance,
                  y: Math.sin((p.angle * Math.PI) / 180) * p.distance,
                  opacity: 0,
                  scale: 0,
                }}
                transition={{ duration: 0.9, ease: "easeOut", delay: 0.1 }}
              />
            ))}

            {/* Ring pulse */}
            <motion.div
              className="absolute inset-0 rounded-full border-2"
              style={{ borderColor: iconColor }}
              initial={{ scale: 0.5, opacity: 1 }}
              animate={{ scale: 2.5, opacity: 0 }}
              transition={{ duration: 0.8, ease: "easeOut" }}
            />
            <motion.div
              className="absolute inset-0 rounded-full border"
              style={{ borderColor: iconColor }}
              initial={{ scale: 0.5, opacity: 0.8 }}
              animate={{ scale: 2, opacity: 0 }}
              transition={{ duration: 0.8, delay: 0.1, ease: "easeOut" }}
            />

            {/* Main circle */}
            <motion.div
              className="relative z-10 flex flex-col items-center gap-3"
              initial={{ scale: 0, rotate: -30 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ type: "spring", stiffness: 400, damping: 20, delay: 0.05 }}
            >
              <motion.div
                className="w-20 h-20 rounded-full flex items-center justify-center border-2"
                style={{
                  backgroundColor: `${iconColor}15`,
                  borderColor: `${iconColor}60`,
                  boxShadow: `0 0 30px ${iconColor}40`,
                }}
                animate={{ boxShadow: [`0 0 30px ${iconColor}40`, `0 0 60px ${iconColor}80`, `0 0 30px ${iconColor}40`] }}
                transition={{ duration: 1, repeat: Infinity }}
              >
                <Icon className="w-10 h-10" style={{ color: iconColor }} />
              </motion.div>

              <motion.div
                className="text-center"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 }}
              >
                <div className="font-mono font-bold text-white text-lg tracking-wider">{message}</div>
                {subMessage && (
                  <div className="font-mono text-xs text-white/60 mt-1">{subMessage}</div>
                )}
              </motion.div>
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
