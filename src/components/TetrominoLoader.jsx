import { useStore } from '../store';
import './TetrominoLoader.css';

function TetrominoLoader() {
  const appBgColor = useStore((state) => state.appBgColor);

  return (
    <div
      class="tetromino-loader"
      role="status"
      aria-label="Loading"
      style={{ '--tetromino-theme-color': appBgColor }}
    >
      <div class="tetromino-platform" aria-hidden="true" />
      <div class="tetrominos" aria-hidden="true">
        <div class="tetromino box1" />
        <div class="tetromino box2" />
        <div class="tetromino box3" />
        <div class="tetromino box4" />
      </div>
    </div>
  );
}

export default TetrominoLoader;
